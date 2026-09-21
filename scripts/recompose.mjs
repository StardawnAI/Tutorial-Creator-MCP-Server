/**
 * Render a finished recording again from its timeline, without recording anything.
 *
 *   node scripts/recompose.mjs <recording folder> [music] [--avatar <look>] [--corner <c>]
 *
 *   music  "generate"      compose a new piece for this video (Google Lyria)
 *          a path          use that file
 *          omitted         the music the recording was made with
 *
 *   --avatar <look>        have a HeyGen look speak the narration, as a bubble in the
 *                          corner: a look id, a group id, or part of a name
 *   --corner <c>           bottom-right (default), bottom-left, top-right, top-left
 *   --presence speaking    show the bubble only while a line is spoken; by default the
 *                          avatar idles on screen between the lines as well
 *   --avatar-clips <dir>   use clips already on disk instead of rendering new ones,
 *                          named 000.mp4, 001.mp4, ... in narration order, with an
 *                          optional idle.mp4 for the gaps
 *
 * Every recording keeps its captures, narration clips and timeline.json, so a fix to
 * the mix, different music, or an avatar added afterwards reaches an existing video in
 * a minute instead of a whole new recording - which, for an app behind a login, may
 * not be repeatable.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loadConfig, resolveMusicTrack } from '../dist/lib/env.js'
import { compose, verifyOutput } from '../dist/lib/compose.js'
import { generateMusic } from '../dist/lib/music-gen.js'
import { renderAvatarClips, renderIdleClip, resolveLook } from '../dist/lib/avatar.js'

/**
 * Find a file the timeline refers to, even though the recording has moved.
 *
 * timeline.json stores absolute paths, and a recording outlives the folder it was
 * made in - this project's own directory was renamed, which left every earlier
 * recording pointing at a path that no longer exists. A recording's own files always
 * sit beside its timeline, so look there before giving up.
 */
function locate(file, dir) {
  if (!file || fs.existsSync(file)) return file
  const base = path.basename(file)
  const parent = path.basename(path.dirname(file))
  for (const candidate of [path.join(dir, base), path.join(dir, parent, base)]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return file
}

/** `--flag value` pairs, and the positional arguments with them removed. */
function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]
    else positional.push(argv[i])
  }
  return { flags, positional }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const dir = positional[0] ? path.resolve(positional[0]) : null
  if (!dir || !fs.existsSync(path.join(dir, 'timeline.json'))) {
    process.stderr.write(
      'usage: node scripts/recompose.mjs <recording folder> [generate | music file] ' +
        '[--avatar <look>] [--corner <corner>] [--avatar-clips <dir>]\n',
    )
    process.exit(1)
  }

  const config = loadConfig()
  const timeline = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'))
  timeline.segments = timeline.segments.map(s => ({ ...s, file: locate(s.file, dir) }))
  timeline.cues = timeline.cues.map(c => ({ ...c, audioFile: locate(c.audioFile, dir) }))
  const recordedMs = timeline.segments.reduce((sum, s) => sum + s.durationMs, 0)
  const lastCueEnd = timeline.cues.reduce((max, c) => Math.max(max, c.atMs + c.durationMs), 0)

  let music = locate(timeline.options.music, dir)
  // The track library moved with the project, so fall back to the same title there.
  if (music && !fs.existsSync(music)) {
    music = resolveMusicTrack(config.musicDir, path.basename(music).replace(/\.[^.]+$/, ''))
  }
  if (positional[1] === 'generate') {
    const made = await generateMusic(config, {
      seconds: Math.max(recordedMs, lastCueEnd + 1200) / 1000,
      outFile: path.join(dir, 'music-composed.mp3'),
    })
    music = made.file
    process.stdout.write(`Composed: ${made.palette}\n`)
  } else if (positional[1]) {
    music = path.resolve(positional[1])
  }

  const spoken = timeline.cues.filter(c => c.audioFile && fs.existsSync(c.audioFile))
  let avatarClips = []
  let avatarIdle = null
  if (flags['avatar-clips']) {
    // Clips rendered elsewhere, or stand-ins: matched to the lines by their order.
    const clipDir = path.resolve(flags['avatar-clips'])
    avatarClips = spoken
      .map((cue, i) => ({
        file: path.join(clipDir, `${String(i).padStart(3, '0')}.mp4`),
        atMs: cue.atMs,
        durationMs: cue.durationMs,
      }))
      .filter(clip => fs.existsSync(clip.file))
    // An idle.mp4 beside them keeps the bubble on screen between the lines.
    const idle = path.join(clipDir, 'idle.mp4')
    if (fs.existsSync(idle)) avatarIdle = idle
    process.stdout.write(
      `Avatar: ${avatarClips.length} clip(s) from ${clipDir}${avatarIdle ? ' plus an idle clip' : ''}\n`,
    )
  } else if (flags.avatar) {
    const look = await resolveLook(config, flags.avatar)
    if (flags.presence !== 'speaking') {
      try {
        avatarIdle = await renderIdleClip(config, {
          look,
          outFile: path.join(dir, 'avatar', 'idle.mp4'),
        })
      } catch (err) {
        process.stdout.write(`No idle clip (${err.message}); the bubble will only show while speaking\n`)
      }
    }
    const rendered = await renderAvatarClips(
      config,
      spoken.map(c => ({
        audioFile: c.audioFile,
        atMs: c.atMs,
        durationMs: c.durationMs,
        text: c.text,
      })),
      { look, outDir: path.join(dir, 'avatar') },
    )
    avatarClips = rendered.clips
    process.stdout.write(
      `Avatar "${look.name}": ${rendered.clips.length}/${spoken.length} lines` +
        (rendered.failures.length ? ` - ${rendered.failures[0]}` : '') +
        '\n',
    )
  }

  const result = await compose(config, {
    rawVideo: timeline.segments,
    cues: timeline.cues,
    zoomEvents: timeline.zoomEvents,
    outputDir: dir,
    outputWidth: timeline.options.width,
    outputHeight: timeline.options.height,
    music,
    musicGainDb: 0,
    subtitles: true,
    avatarClips,
    avatarIdle,
    avatarCorner: flags.corner ?? timeline.options.avatarCorner,
    avatarSize: timeline.options.avatarSize,
  })
  const check = await verifyOutput(config, result.outputFile)

  process.stdout.write(
    `${result.outputFile}\n${result.durationSec.toFixed(1)}s, ${result.width}x${result.height}, ` +
      `${result.cueCount} narration lines, audio ${result.hasAudio ? 'mixed' : 'absent'}` +
      `${result.avatarCount > 0 ? `, ${result.avatarCount} avatar bubbles` : ''}\n` +
      `Music: ${music ? path.basename(music) : 'none'}\n` +
      (check.ok ? '' : `Problems: ${check.problems.join('; ')}\n`),
  )
}

main().catch(err => {
  process.stderr.write(`recompose failed: ${err.stack ?? err.message}\n`)
  process.exit(1)
})
