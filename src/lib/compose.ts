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
import type { AvatarClip } from './avatar.js'
import type { NarrationCue } from './session.js'
import { buildZoomFilter, type ZoomEvent } from './zoom.js'
import { log } from './logger.js'

/** A stretch of capture, and how long the session clock says it lasted. */
export interface RawSegment {
  file: string
  /** Where the stretch starts within the file. */
  startMs?: number
  durationMs: number
}

export interface ComposeOptions {
  /**
   * The capture: one file, or segments played back to back. Segments are cut to
   * exactly the length the session clock gave them - that, and not the length of
   * each file, is what keeps narration on the picture across every cut.
   */
  rawVideo: string | RawSegment[]
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
  /** An avatar saying each line, shown as a round bubble while the line plays. */
  avatarClips?: AvatarClip[]
  /**
   * The same avatar saying nothing, looped under the whole video so the bubble is
   * there between the lines as well. Without it the bubble comes and goes.
   */
  avatarIdle?: string | null
  avatarCorner?: AvatarCorner
  /** Bubble diameter as a fraction of the video width. */
  avatarSize?: number
}

export type AvatarCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

/** Bubble diameter as a fraction of the video width, when nothing else is asked for. */
export const AVATAR_SIZE = 0.18
export const AVATAR_CORNER: AvatarCorner = 'bottom-right'

export interface ComposeResult {
  outputFile: string
  durationSec: number
  width: number
  height: number
  hasAudio: boolean
  cueCount: number
  /** Camera moves that made it into the render. */
  zoomCount: number
  /** Avatar bubbles that made it into the render. */
  avatarCount: number
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
 *
 * A third lesson came from a real recording: short lines stayed several dB too quiet.
 * One-pass `loudnorm` looks three seconds ahead and needs that much signal to settle,
 * so a 1.4-second "I log in to InStar." came out at -22.5 LUFS against a -16 target -
 * level with the music. Padding the clip with silence to six seconds gives the filter
 * its window, silence is gated out of the measurement so nothing else changes, and the
 * padding is trimmed off again afterwards. On the same four clips, -22.5, -21.4 and
 * -20.7 LUFS became -17.3, -17.1 and -16.6.
 */
export function narrationChain(seconds: number): string {
  return (
    `apad=whole_dur=6,loudnorm=I=${NARRATION_LUFS}:TP=${NARRATION_PEAK_CEILING}:LRA=11,` +
    `atrim=0:${seconds.toFixed(3)}`
  )
}

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
      `[${i + 1}:a]${narrationChain(cue.durationMs / 1000)},` +
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

/**
 * The filtergraph that plays segments back to back as one stream, labelled `joined`.
 *
 * Each segment is cut to the length the session clock gave it, counted in whole
 * output frames from the start of the recording rather than per segment. Rounding
 * each segment on its own drifts by up to a frame per cut, and a recording with a
 * dozen cuts would end with the narration visibly behind the picture; rounding the
 * running total keeps every boundary within half a frame of the clock.
 *
 * The tail is padded with its last frame first, because a segment's file can end a
 * little before the moment its capture was stopped.
 *
 * Several segments can come from the same file - one browser on air, then another,
 * then the first again - so each is cut out of its file by its own start time.
 */
function joinSegments(segments: RawSegment[], fps: number): string {
  const parts: string[] = []
  const labels: string[] = []
  let clockMs = 0
  segments.forEach((segment, i) => {
    const firstFrame = Math.round((clockMs * fps) / 1000)
    clockMs += segment.durationMs
    const frames = Math.round((clockMs * fps) / 1000) - firstFrame
    // Shorter than half a frame: none of it would reach the video.
    if (frames < 1) return
    parts.push(
      `[${i}:v]trim=start=${((segment.startMs ?? 0) / 1000).toFixed(3)},setpts=PTS-STARTPTS,` +
        `fps=${fps},tpad=stop_mode=clone:stop_duration=2,` +
        `trim=end_frame=${frames},setpts=PTS-STARTPTS,setsar=1[s${i}]`,
    )
    labels.push(`[s${i}]`)
  })
  return `${parts.join(';\n')};\n${labels.join('')}concat=n=${labels.length}:v=1:a=0[joined]`
}

/**
 * The avatar as a round bubble in one corner of the picture.
 *
 * Two layers. An idle clip - the person standing there, saying nothing - is looped
 * under the entire video, so the bubble is simply always there. The clips of the
 * lines are laid on top of it at their own moments, and fade in and out over it, so
 * the change from listening to speaking is a dissolve rather than a jump.
 *
 * Without an idle clip only the second layer exists, and the bubble appears for each
 * line and vanishes between them. That was the first version, and on a video with
 * four lines in 68 seconds it reads as a glitch rather than as a presenter.
 *
 * Deliberately a bubble rather than a cut-out figure. HeyGen can return the person
 * on a transparent background, but that depends on the look, on the engine, and on
 * alpha surviving the webm round trip; a circular crop of the plain mp4 works
 * whatever comes back, and reads as a presenter either way.
 *
 * The mask is drawn by `geq` into the alpha plane, with the last pixel and a half
 * ramped so the edge is not a staircase, and a thin light ring just inside it so the
 * bubble keeps its shape against a pale page. Measured: a 12-second render with one
 * bubble takes 1.3 s, so the per-pixel expression costs nothing worth avoiding.
 *
 * The overlay is applied after the camera moves, not before, so the avatar is never
 * zoomed into or pushed off the frame.
 */
export function avatarOverlayFilters(
  clips: AvatarClip[],
  options: {
    /** Input index of the first clip; they follow in order. */
    firstInput: number
    outputWidth: number
    corner: AvatarCorner
    /** Diameter as a fraction of the output width. */
    size: number
    fps: number
    inLabel: string
    outLabel: string
    /** Input index of the looped idle clip, if there is one. */
    idleInput?: number
    /** How long the finished video is, so the idle layer covers all of it. */
    totalSeconds?: number
  },
): string[] {
  const diameter = Math.round((options.outputWidth * options.size) / 2) * 2
  const margin = Math.round(options.outputWidth * 0.025)
  const centre = diameter / 2
  const edge = centre - 2
  const ringInner = Math.max(0, edge - 6)
  const distance = `hypot(X-${centre},Y-${centre})`

  /** Square, circular, and the same in both layers. */
  const bubble =
    `scale=${diameter}:${diameter}:force_original_aspect_ratio=increase,` +
    `crop=${diameter}:${diameter},format=yuva420p,` +
    `geq=lum='if(between(${distance},${ringInner},${edge}),240,p(X,Y))'` +
    `:cb='if(between(${distance},${ringInner},${edge}),128,p(X,Y))'` +
    `:cr='if(between(${distance},${ringInner},${edge}),128,p(X,Y))'` +
    `:a='255*clip((${edge}-${distance})/1.5,0,1)'`

  const place =
    `x=${options.corner.endsWith('right') ? `W-w-${margin}` : String(margin)}:` +
    `y=${options.corner.startsWith('bottom') ? `H-h-${margin}` : String(margin)}`

  const filters: string[] = []
  let previous = options.inLabel

  if (options.idleInput !== undefined && options.totalSeconds) {
    // The idle clip is fed in looping; it is cut to the video's length here.
    filters.push(
      `[${options.idleInput}:v]fps=${options.fps},trim=0:${options.totalSeconds.toFixed(3)},` +
        `setpts=PTS-STARTPTS,${bubble},fade=t=in:st=0:d=0.6:alpha=1[avidle]`,
    )
    const next = clips.length > 0 ? 'avstageidle' : options.outLabel
    filters.push(`[${previous}][avidle]overlay=${place}:eof_action=pass:repeatlast=0[${next}]`)
    previous = next
  }

  clips.forEach((clip, i) => {
    const seconds = clip.durationMs / 1000
    const fade = Math.min(0.3, seconds / 4)
    const label = `av${i}`
    const next = i === clips.length - 1 ? options.outLabel : `avstage${i}`

    filters.push(
      `[${options.firstInput + i}:v]fps=${options.fps},` +
        // A clip can come back a hair shorter than the line it speaks; hold its last
        // frame rather than letting the bubble blink out before the sentence ends.
        `tpad=stop_mode=clone:stop_duration=1,trim=0:${seconds.toFixed(3)},setpts=PTS-STARTPTS,` +
        `${bubble},` +
        `fade=t=in:st=0:d=${fade.toFixed(2)}:alpha=1,` +
        `fade=t=out:st=${Math.max(0, seconds - fade).toFixed(3)}:d=${fade.toFixed(2)}:alpha=1,` +
        `setpts=PTS+${(clip.atMs / 1000).toFixed(3)}/TB[${label}]`,
    )
    filters.push(
      `[${previous}][${label}]overlay=${place}:eof_action=pass:repeatlast=0[${next}]`,
    )
    previous = next
  })

  return filters
}

/** Pass 2 - transcode the picture and mux the audio. */
export async function compose(config: Config, options: ComposeOptions): Promise<ComposeResult> {
  const ffmpeg = requireFfmpeg(config)
  const ffprobe = requireFfprobe(config)

  // Several segments are joined in the graph; a single one is used as it is.
  const joined =
    typeof options.rawVideo !== 'string' && options.rawVideo.length > 1 ? options.rawVideo : null
  const single =
    typeof options.rawVideo === 'string' ? options.rawVideo : options.rawVideo[0]?.file
  const files = joined ? joined.map(s => s.file) : single ? [single] : []
  if (files.length === 0) throw new Error('The recording holds no video.')
  const missing = files.find(f => !fs.existsSync(f))
  if (missing) throw new Error(`Raw recording not found: ${missing}`)

  const recordedSec = joined
    ? joined.reduce((sum, s) => sum + s.durationMs, 0) / 1000
    : (await probeVideo(ffprobe, files[0] as string)).durationSec
  const lastCueEndMs = options.cues.reduce(
    (max, c) => Math.max(max, c.atMs + c.durationMs),
    0,
  )
  // Give the last sentence room to finish, and a beat of silence after it.
  const requiredSec = Math.max(recordedSec, lastCueEndMs / 1000 + 1.2)
  const needsExtension = requiredSec > recordedSec + 0.05

  const audioFile = await buildAudio(config, options, requiredSec)

  const outputName = options.outputName ?? 'tutorial.mp4'
  const outputFile = path.join(options.outputDir, outputName)

  const args: string[] = [
    '-hide_banner', '-loglevel', 'error', '-y',
    // zoompan enlarges pixels; its default scaler makes that look worse than it has
    // to. This applies to every swscale instance in the graph, zoompan's included.
    '-sws_flags', 'lanczos+accurate_rnd',
    ...files.flatMap(f => ['-i', f]),
  ]
  const audioIndex = files.length
  if (audioFile) args.push('-i', audioFile)

  // Only bubbles that start inside the finished video, and only ones still on disk.
  const avatarClips = (options.avatarClips ?? []).filter(
    clip => fs.existsSync(clip.file) && clip.atMs / 1000 < requiredSec,
  )
  const idleClip =
    options.avatarIdle && fs.existsSync(options.avatarIdle) ? options.avatarIdle : null

  let nextInput = files.length + (audioFile ? 1 : 0)
  let idleInput: number | undefined
  if (idleClip) {
    // Looped, because one short clip has to cover every gap in a long tutorial.
    args.push('-stream_loop', '-1', '-i', idleClip)
    idleInput = nextInput++
  }
  const firstAvatarInput = nextInput
  for (const clip of avatarClips) args.push('-i', clip.file)

  const OUTPUT_FPS = 25
  const chain: string[] = []

  if (needsExtension) {
    // Hold the final frame so narration that runs past the last on-screen action
    // is not cut off.
    const extraSec = requiredSec - recordedSec
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
  // The bubbles go on last, over the finished picture, so a camera move cannot crop
  // or magnify them.
  const hasAvatar = avatarClips.length > 0 || Boolean(idleClip)
  const pictureLabel = hasAvatar ? 'picture' : 'vout'
  const graph = [
    joined
      ? `${joinSegments(joined, OUTPUT_FPS)};\n[joined]${chain.join(',\n')}[${pictureLabel}]`
      : `[0:v]${chain.join(',\n')}[${pictureLabel}]`,
  ]
  if (hasAvatar) {
    log.info(
      `Placing ${avatarClips.length} spoken avatar clip(s)` +
        `${idleClip ? ' over a looped idle bubble' : ''}, ` +
        `${options.avatarCorner ?? AVATAR_CORNER}`,
    )
    graph.push(
      ...avatarOverlayFilters(avatarClips, {
        firstInput: firstAvatarInput,
        outputWidth: options.outputWidth,
        corner: options.avatarCorner ?? AVATAR_CORNER,
        size: options.avatarSize ?? AVATAR_SIZE,
        fps: OUTPUT_FPS,
        inLabel: pictureLabel,
        outLabel: 'vout',
        idleInput,
        totalSeconds: requiredSec,
      }),
    )
  }

  const videoGraphFile = path.join(options.outputDir, 'video-graph.txt')
  fs.writeFileSync(videoGraphFile, graph.join(';\n'))
  args.push('-filter_complex_script', videoGraphFile)

  args.push(
    '-map', '[vout]',
    ...(audioFile ? ['-map', `${audioIndex}:a:0`] : []),
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
    avatarCount: avatarClips.length,
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
