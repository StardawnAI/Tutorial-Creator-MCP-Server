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
import { buildZoomFilter, type ZoomEvent } from './zoom.js'
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
  /** Camera moves recorded during the session. */
  zoomEvents?: ZoomEvent[]
  /** Size of the finished video. The capture is a whole multiple of this. */
  outputWidth: number
  outputHeight: number
}

export interface ComposeResult {
  outputFile: string
  durationSec: number
  width: number
  height: number
  hasAudio: boolean
  cueCount: number
  /** Camera moves that made it into the render. */
  zoomCount: number
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

/** Speech level for web video, and the headroom left above it. */
const NARRATION_LUFS = -16
const NARRATION_PEAK_CEILING = -1.5

/** Resting level for music under speech, and its ceiling. */
const MUSIC_LUFS = -22
const MUSIC_PEAK_CEILING = -2

/** Integrated loudness and true peak of a file, in LUFS and dBFS. */
async function measureLoudness(
  ffmpeg: string,
  file: string,
): Promise<{ integrated: number; truePeak: number } | null> {
  const { stderr } = await run(ffmpeg, [
    '-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ]).catch(() => ({ stdout: '', stderr: '' }))

  // Only the trailing summary is the measurement; the running values start at -70.
  const integrated = Number(
    stderr.match(/Integrated loudness:\s*[\r\n]+\s*I:\s*(-?[\d.]+)\s*LUFS/)?.[1] ?? NaN,
  )
  const truePeak = Number(
    stderr.match(/True peak:\s*[\r\n]+\s*Peak:\s*(-?[\d.]+)\s*dBFS/)?.[1] ?? NaN,
  )
  if (!Number.isFinite(integrated)) return null
  return { integrated, truePeak: Number.isFinite(truePeak) ? truePeak : -3 }
}

/**
 * The filter that brings one narration clip up to a consistent speaking level.
 *
 * Per clip, deliberately, and by loudness normalisation rather than by gain. Two
 * earlier attempts got this wrong, and both failures are worth keeping written down.
 *
 * A single `loudnorm` across the assembled timeline does not work. The timeline is
 * mostly silence - a few seconds of speech every ten seconds or so - and the filter
 * never settles on it: a clip measured at -27.8 LUFS still came out at -23.1 in the
 * finished mix, quieter than the music it was meant to sit above.
 *
 * Measuring each clip and applying a fixed gain does not work either, which is the
 * less obvious one. Speech has a crest factor of around 20 dB: the ElevenLabs clips
 * here averaged -23.5 LUFS while peaking at -2.8 dBFS. Reaching -16 LUFS needs
 * +7.5 dB, but only +1.3 dB fits under a -1.5 dBFS ceiling, so a gain calculation
 * that refuses to clip refuses to do its job - narration landed at -21.7 LUFS against
 * music at -22.0, which is the "I can't hear the voice" complaint written as numbers.
 * Loudness and true peak cannot both be satisfied by a constant gain.
 *
 * `loudnorm` is built for exactly this and handles it in one pass. Supplying it with
 * separately measured figures was tried and dropped: it produced identical results on
 * real narration (-17.1 vs -17.1 LUFS) while adding an analysis run per clip and a
 * trap - a clip under three seconds has no measurable loudness range, and given
 * `measured_LRA=0` the filter falls back to linear scaling and gives up at the peak
 * ceiling, exactly the failure it was brought in to avoid.
 */
const NARRATION_CHAIN = `loudnorm=I=${NARRATION_LUFS}:TP=${NARRATION_PEAK_CEILING}:LRA=11`

/**
 * Pass 1 - build the audio bed.
 *
 * Each narration clip is levelled on its own and delayed onto a silent timeline.
 * Music is looped to length, faded at both ends, pushed down by `musicGainDb`, then
 * ducked under the voice with a sidechain compressor keyed off the narration itself.
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
  const musicLoudness = hasMusic ? await measureLoudness(ffmpeg, options.music as string) : null
  if (hasMusic && !musicLoudness) {
    log.warn('Could not measure the music; it will be laid in at its own level')
  }

  // Narration: level each clip on its own, convert to stereo 44.1k, then delay it
  // into position. Clips never overlap - the recording waits out each line - so the
  // sum needs no further gain staging.
  const narrationLabels: string[] = []
  spoken.forEach((cue, i) => {
    const label = `n${i}`
    filters.push(
      `[${i + 1}:a]${NARRATION_CHAIN},` +
        // After loudnorm, which resamples to 192 kHz internally.
        `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
        `adelay=${Math.max(0, Math.round(cue.atMs))}:all=1[${label}]`,
    )
    narrationLabels.push(`[${label}]`)
  })

  let voiceLabel: string | null = null
  if (narrationLabels.length > 0) {
    log.info(`Levelling ${spoken.length} narration clips to ${NARRATION_LUFS} LUFS`)
    filters.push(
      `[0:a]${narrationLabels.join('')}amix=inputs=${narrationLabels.length + 1}:` +
        `normalize=0:duration=first[voice]`,
    )
    voiceLabel = 'voice'
  }

  /**
   * Normalise the music to a known loudness before touching its level. Source
   * tracks vary enormously, and simply attenuating by a fixed amount produced a
   * mix measured at -41.7 LUFS - effectively inaudible. Normalising first makes
   * the result predictable whatever track is supplied.
   */
  /**
   * Music is levelled by a measured constant gain, not by `loudnorm`.
   *
   * The opposite of the narration, and for the opposite reason. `loudnorm` in one
   * pass needs a moment to settle, which on continuous programme material is
   * invisible - but a tutorial's music starts at the first frame and the first
   * seconds are the ones the viewer hears. Measured: the opening of a finished
   * recording came out at -27 LUFS against a -22 target, purely from that ramp.
   *
   * Music can be levelled this way precisely because it is not speech. This track
   * measures 3.2 LU of loudness range against speech's 20 dB of crest, so a single
   * gain hits the target exactly, and it is on target from the first sample.
   */
  const musicChain = (targetLufs: number): string => {
    const fadeOutStart = Math.max(0, targetSec - 2.5)
    const toTarget = musicLoudness ? targetLufs - musicLoudness.integrated : 0
    const toCeiling = musicLoudness ? MUSIC_PEAK_CEILING - musicLoudness.truePeak : 0
    const gain = musicLoudness ? Math.min(toTarget, toCeiling) : 0
    const level = gain + options.musicGainDb

    return (
      `[${musicIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
      (Math.abs(level) > 0.05 ? `volume=${level.toFixed(2)}dB,` : '') +
      `afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=2.5`
    )
  }

  let finalLabel: string
  if (hasMusic && voiceLabel) {
    /**
     * Set the music to a level it can actually be heard at, and let the sidechain
     * take it back down while words are playing.
     *
     * It used to be normalised to -32 LUFS here, on the reasoning that background
     * music belongs in the background. That confused two different moments. Measured
     * on a finished recording: the opening, before the first line of narration, came
     * out at -31.9 LUFS - roughly 13 dB under a normal listening level, which on a
     * laptop is silence. The viewer's verdict was simply "I can't hear anything".
     *
     * -22 LUFS measures at -21.6 on its own and is ducked to -38.6 under the voice,
     * leaving the 17 dB of separation that speech over music wants. Both figures are
     * asserted in scripts/e2e.mjs so this cannot quietly regress again.
     */
    filters.push(`[${voiceLabel}]asplit=2[voiceout][voicekey]`)
    filters.push(`${musicChain(MUSIC_LUFS)}[music]`)
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
    // Nothing to make room for, so the music carries the video at listening level.
    filters.push(`${musicChain(MUSIC_LUFS + 2)}[aout]`)
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

  const args: string[] = [
    '-hide_banner', '-loglevel', 'error', '-y',
    // zoompan enlarges pixels; its default scaler makes that look worse than it has
    // to. This applies to every swscale instance in the graph, zoompan's included.
    '-sws_flags', 'lanczos+accurate_rnd',
    '-i', options.rawVideo,
  ]
  if (audioFile) args.push('-i', audioFile)

  const OUTPUT_FPS = 25
  const chain: string[] = []

  if (needsExtension) {
    // Hold the final frame so narration that runs past the last on-screen action
    // is not cut off.
    const extraSec = requiredSec - info.durationSec
    chain.push(`tpad=stop_mode=clone:stop_duration=${extraSec.toFixed(3)}`)
    log.info(`Extending video by ${extraSec.toFixed(2)}s to cover trailing narration`)
  }

  // The screencast delivers frames as the page paints, so its timing is uneven.
  // zoompan reads `ot` off the frame timestamps, which only means anything once the
  // stream is constant-rate - hence this before, not after.
  chain.push(`fps=${OUTPUT_FPS}`)

  const zoomFilter = buildZoomFilter(options.zoomEvents ?? [], {
    viewportWidth: options.outputWidth,
    viewportHeight: options.outputHeight,
    outputWidth: options.outputWidth,
    outputHeight: options.outputHeight,
    fps: OUTPUT_FPS,
    rampMs: 700,
  })

  if (zoomFilter) {
    // zoompan emits at the output size, so it does the downscale as well.
    chain.push(zoomFilter)
    log.info(`Applying ${options.zoomEvents?.length ?? 0} camera move(s)`)
  } else {
    chain.push(
      `scale=${options.outputWidth}:${options.outputHeight}:flags=lanczos`,
    )
  }

  // Written to a file: a filtergraph with several camera moves comfortably exceeds
  // the Windows command-line limit.
  //
  // The output is labelled and mapped explicitly. Naming any `-map` at all switches
  // ffmpeg's automatic stream selection off, so the audio map below would otherwise
  // leave the picture with no route to the file.
  const videoGraphFile = path.join(options.outputDir, 'video-graph.txt')
  fs.writeFileSync(videoGraphFile, `[0:v]${chain.join(',\n')}[vout]`)
  args.push('-filter_complex_script', videoGraphFile)

  args.push(
    '-map', '[vout]',
    ...(audioFile ? ['-map', '1:a:0'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', String(OUTPUT_FPS), '-fps_mode', 'cfr',
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
    width: options.outputWidth,
    height: options.outputHeight,
    hasAudio: Boolean(audioFile),
    cueCount: options.cues.length,
    zoomCount: zoomFilter ? (options.zoomEvents ?? []).length : 0,
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
