/**
 * Render a finished recording again from its timeline, without recording anything.
 *
 *   node scripts/recompose.mjs <recording folder> [music]
 *
 *   music  "generate"      compose a new piece for this video (Google Lyria)
 *          a path          use that file
 *          omitted         the music the recording was made with
 *
 * Every recording keeps its captures, narration clips and timeline.json, so a fix to
 * the mix, or different music, reaches an existing video in a minute instead of a
 * whole new recording - which, for an app behind a login, may not be repeatable.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loadConfig } from '../dist/lib/env.js'
import { compose, verifyOutput } from '../dist/lib/compose.js'
import { generateMusic } from '../dist/lib/music-gen.js'

async function main() {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : null
  if (!dir || !fs.existsSync(path.join(dir, 'timeline.json'))) {
    process.stderr.write('usage: node scripts/recompose.mjs <recording folder> [generate | music file]\n')
    process.exit(1)
  }

  const config = loadConfig()
  const timeline = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'))
  const recordedMs = timeline.segments.reduce((sum, s) => sum + s.durationMs, 0)
  const lastCueEnd = timeline.cues.reduce((max, c) => Math.max(max, c.atMs + c.durationMs), 0)

  let music = timeline.options.music
  if (process.argv[3] === 'generate') {
    const made = await generateMusic(config, {
      seconds: Math.max(recordedMs, lastCueEnd + 1200) / 1000,
      outFile: path.join(dir, 'music-composed.mp3'),
    })
    music = made.file
    process.stdout.write(`Composed: ${made.palette}\n`)
  } else if (process.argv[3]) {
    music = path.resolve(process.argv[3])
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
  })
  const check = await verifyOutput(config, result.outputFile)

  process.stdout.write(
    `${result.outputFile}\n${result.durationSec.toFixed(1)}s, ${result.width}x${result.height}, ` +
      `${result.cueCount} narration lines, audio ${result.hasAudio ? 'mixed' : 'absent'}\n` +
      `Music: ${music ? path.basename(music) : 'none'}\n` +
      (check.ok ? '' : `Problems: ${check.problems.join('; ')}\n`),
  )
}

main().catch(err => {
  process.stderr.write(`recompose failed: ${err.stack ?? err.message}\n`)
  process.exit(1)
})
