/**
 * Composition: raw screen recording + narration + music -> finished mp4.
 *
 * Two ffmpeg passes on purpose. The audio mix is written out as its own file first,
 * so when something sounds wrong it can be listened to in isolation instead of
 * being buried inside one enormous filtergraph.
 *
 * Filters used are all confirmed present in the local ffmpeg build: adelay, amix,
 * sidechaincompress, loudnorm, afade, apad, anullsrc. Note that libmp3lame is
 * absent (mp3 decoding still works, AAC handles encoding) and libass is absent, so
 * subtitles are muxed as a soft `mov_text` track rather than burned in.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './env.js'
import { requireFfmpeg, requireFfprobe } from './env.js'
import { probeDuration, probeVideo, run } from './ffmpeg.js'
import type { NarrationCue } from './session.js'
import { log } from './logger.js'

export interface ComposeOptions {
  rawVideo: string
  cues: NarrationCue[]
  outputDir: string
  /** Background music file, or null. */
  music: string | null
  /**
   * Fine-tuning offset on the music level, in dB. The music is first normalised to
   * a fixed target loudness, so 0 already sounds right; this only nudges it.
   */
  musicGainDb: number
  /** Write a soft subtitle track built from the narration text. */
  subtitles: boolean
  /** Final file name, without directory. */
  outputName?: string
}

export interface ComposeResult {
  outputFile: string
  durationSec: number
  width: number
  height: number
  hasAudio: boolean
  cueCount: number
}

/** Seconds -> `HH:MM:SS,mmm` for SubRip. */
function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const milli = total % 1000
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(milli, 3)}`
}

export function buildSrt(cues: NarrationCue[]): string {
  return cues
    .filter(c => c.text.trim().length > 0)
    .map((cue, i) => {
      const start = srtTime(cue.atMs)
      const end = srtTime(cue.atMs + Math.max(cue.durationMs, 900))
      // Keep subtitle lines readable: break long sentences at roughly 42 chars.
      const text = cue.text
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/(.{1,42})(\s|$)/g, '$1\n')
        .trim()
      return `${i + 1}\n${start} --> ${end}\n${text}\n`
    })
    .join('\n')
}

/**
 * Pass 1 - build the audio bed.
 *
 * Narration clips are delayed onto a silent timeline and summed; the result is
 * loudness-normalised. Music is looped to length, faded at both ends, pushed down
 * by `musicGainDb`, then ducked under the voice with a sidechain compressor keyed
 * off the narration itself.
 */
async function buildAudio(
  config: Config,
  options: ComposeOptions,
  targetSec: number,
): Promise<string | null> {
  const ffmpeg = requireFfmpeg(config)
  const spoken = options.cues.filter(c => c.audioFile && fs.existsSync(c.audioFile))
  const hasMusic = Boolean(options.music && fs.existsSync(options.music))

  if (spoken.length === 0 && !hasMusic) {
    log.info('No narration and no music - the video will be silent')
    return null
  }

  const mixFile = path.join(options.outputDir, 'mix.m4a')
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y']
  const filters: string[] = []

  // Input 0 is always silence spanning the whole video, which guarantees the mix
  // is exactly as long as the picture even if narration stops early.
  args.push('-f', 'lavfi', '-t', targetSec.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo')

  spoken.forEach(cue => {
    args.push('-i', cue.audioFile as string)
  })

  if (hasMusic) {
    // Loop the track so a short piece still covers a long tutorial.
    args.push('-stream_loop', '-1', '-t', targetSec.toFixed(3), '-i', options.music as string)
  }

  const musicIndex = 1 + spoken.length

  // Narration: normalise each clip to stereo 44.1k, then delay it into position.
  const narrationLabels: string[] = []
  spoken.forEach((cue, i) => {
    const label = `n${i}`
    filters.push(
      `[${i + 1}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
        `adelay=${Math.max(0, Math.round(cue.atMs))}:all=1[${label}]`,
    )
    narrationLabels.push(`[${label}]`)
  })

  let voiceLabel: string | null = null
  if (narrationLabels.length > 0) {
    filters.push(
      `[0:a]${narrationLabels.join('')}amix=inputs=${narrationLabels.length + 1}:` +
        `normalize=0:duration=first[voicemix]`,
    )
    // -16 LUFS is the usual target for spoken web video.
    filters.push(`[voicemix]loudnorm=I=-16:TP=-1.5:LRA=11[voice]`)
    voiceLabel = 'voice'
  }

  /**
   * Normalise the music to a known loudness before touching its level. Source
   * tracks vary enormously, and simply attenuating by a fixed amount produced a
   * mix measured at -41.7 LUFS - effectively inaudible. Normalising first makes
   * the result predictable whatever track is supplied.
   */
  const musicChain = (targetLufs: number): string => {
    const fadeOutStart = Math.max(0, targetSec - 2.5)
    const trim = options.musicGainDb !== 0 ? `volume=${options.musicGainDb}dB,` : ''
    return (
      `[${musicIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
      `loudnorm=I=${targetLufs}:TP=-2:LRA=11,` +
      trim +
      `afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=2.5`
    )
  }

  let finalLabel: string
  if (hasMusic && voiceLabel) {
    // Music sits well under a -16 LUFS voice; the sidechain then dips it further
    // while words are actually playing.
    filters.push(`[${voiceLabel}]asplit=2[voiceout][voicekey]`)
    filters.push(`${musicChain(-32)}[music]`)
    filters.push(
      `[music][voicekey]sidechaincompress=threshold=0.03:ratio=12:attack=15:release=450` +
        `:makeup=1[ducked]`,
    )
    filters.push(`[voiceout][ducked]amix=inputs=2:normalize=0:duration=first[aout]`)
    finalLabel = 'aout'
  } else if (voiceLabel) {
    finalLabel = voiceLabel
  } else {
    // No narration: the music carries the video on its own, so it needs a proper
    // listening level rather than a background one.
    filters.push(`${musicChain(-20)}[aout]`)
    finalLabel = 'aout'
  }

  // The graph can get long with many cues; pass it via a file so we never hit the
  // Windows command-line length limit.
  const graphFile = path.join(options.outputDir, 'audio-graph.txt')
  fs.writeFileSync(graphFile, filters.join(';\n'))

  args.push(
    '-filter_complex_script', graphFile,
    '-map', `[${finalLabel}]`,
    '-t', targetSec.toFixed(3),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    mixFile,
  )

  await run(ffmpeg, args)
  log.info(`Audio bed written: ${path.basename(mixFile)} (${spoken.length} narration clips)`)
  return mixFile
}

/** Pass 2 - transcode the picture and mux the audio. */
export async function compose(config: Config, options: ComposeOptions): Promise<ComposeResult> {
  const ffmpeg = requireFfmpeg(config)
  const ffprobe = requireFfprobe(config)

  if (!fs.existsSync(options.rawVideo)) {
    throw new Error(`Raw recording not found: ${options.rawVideo}`)
  }

  const info = await probeVideo(ffprobe, options.rawVideo)
  const lastCueEndMs = options.cues.reduce(
    (max, c) => Math.max(max, c.atMs + c.durationMs),
    0,
  )
  // Give the last sentence room to finish, and a beat of silence after it.
  const requiredSec = Math.max(info.durationSec, lastCueEndMs / 1000 + 1.2)
  const needsExtension = requiredSec > info.durationSec + 0.05

  const audioFile = await buildAudio(config, options, requiredSec)

  const outputName = options.outputName ?? 'tutorial.mp4'
  const outputFile = path.join(options.outputDir, outputName)

  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y', '-i', options.rawVideo]
  if (audioFile) args.push('-i', audioFile)

  if (needsExtension) {
    // Hold the final frame so narration that runs past the last on-screen action
    // is not cut off.
    const extraSec = requiredSec - info.durationSec
    args.push('-vf', `tpad=stop_mode=clone:stop_duration=${extraSec.toFixed(3)}`)
    log.info(`Extending video by ${extraSec.toFixed(2)}s to cover trailing narration`)
  }

  args.push(
    '-map', '0:v:0',
    ...(audioFile ? ['-map', '1:a:0'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', '25', '-fps_mode', 'cfr',
    ...(audioFile ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    '-movflags', '+faststart',
    '-t', requiredSec.toFixed(3),
    outputFile,
  )

  await run(ffmpeg, args)

  if (options.subtitles && options.cues.length > 0) {
    const srtFile = path.join(options.outputDir, 'captions.srt')
    fs.writeFileSync(srtFile, buildSrt(options.cues), 'utf8')
    const subbed = path.join(options.outputDir, outputName.replace(/\.mp4$/, '.subtitled.mp4'))
    // Soft subtitles: this ffmpeg build has no libass, so burning in is unavailable.
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', outputFile, '-i', srtFile,
      '-map', '0', '-map', '1',
      '-c', 'copy', '-c:s', 'mov_text',
      subbed,
    ]).catch(err => log.warn('Subtitle muxing failed; the plain mp4 is unaffected', err))
  }

  const finalDuration = (await probeDuration(ffprobe, outputFile)) ?? requiredSec

  return {
    outputFile,
    durationSec: finalDuration,
    width: info.width,
    height: info.height,
    hasAudio: Boolean(audioFile),
    cueCount: options.cues.length,
  }
}

/**
 * Sanity-check a finished render: a recording that is entirely black, or has no
 * motion at all, means the capture failed even though ffmpeg reported success.
 */
export async function verifyOutput(
  config: Config,
  file: string,
): Promise<{ ok: boolean; problems: string[] }> {
  const ffmpeg = requireFfmpeg(config)
  const problems: string[] = []

  const { stderr } = await run(ffmpeg, [
    '-hide_banner', '-v', 'info',
    '-i', file,
    '-vf', 'scale=320:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '-',
  ]).catch(() => ({ stdout: '', stderr: '' }))

  const values = [...stderr.matchAll(/YAVG=([0-9.]+)/g)].map(m => Number(m[1]))
  if (values.length === 0) {
    problems.push('Could not read any frames back from the finished file.')
  } else {
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    // 16 is the YUV value for black; anything at or below 17 means an empty capture.
    if (avg <= 17) problems.push(`The video is essentially black (mean luma ${avg.toFixed(1)}).`)
    const distinct = new Set(values.map(v => v.toFixed(1))).size
    if (distinct <= 1 && values.length > 5) {
      problems.push('Every frame is identical - nothing was captured moving.')
    }
  }

  return { ok: problems.length === 0, problems }
}
