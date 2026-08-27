/**
 * Cut a long music file into its chapters and put them in `assets/music/`.
 *
 *   node scripts/split-music.mjs "<file>" [chapters.json]
 *
 * A one-hour mix is a poor default for a three-minute tutorial: whichever minute
 * happens to line up with the recording is the minute the viewer gets. Cut into
 * named pieces, a track can be chosen per recording instead.
 *
 * Chapter list format - a JSON array of `{ "at": "MM:SS", "title": "..." }`, in
 * order. The last piece runs to the end of the file.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../dist/lib/env.js'
import { run } from '../dist/lib/ffmpeg.js'
import { slugify } from '../dist/lib/env.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** "MM:SS" or "H:MM:SS" -> seconds. */
function toSeconds(stamp) {
  const parts = stamp.split(':').map(Number)
  if (parts.some(n => !Number.isFinite(n))) throw new Error(`Bad timestamp: ${stamp}`)
  return parts.reduce((total, n) => total * 60 + n, 0)
}

async function main() {
  const source = process.argv[2]
  const chapterFile = process.argv[3] ?? path.join(root, 'assets', 'chapters.json')

  if (!source || !fs.existsSync(source)) {
    process.stderr.write(`usage: node scripts/split-music.mjs <audio file> [chapters.json]\n`)
    process.exit(1)
  }
  if (!fs.existsSync(chapterFile)) {
    process.stderr.write(`No chapter list at ${chapterFile}\n`)
    process.exit(1)
  }

  const config = loadConfig()
  const chapters = JSON.parse(fs.readFileSync(chapterFile, 'utf8'))
  const outDir = path.join(root, 'assets', 'music')
  fs.mkdirSync(outDir, { recursive: true })

  const { stdout } = await run(config.ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source,
  ])
  const totalSec = Number(stdout.trim())
  process.stdout.write(`Source: ${path.basename(source)} (${(totalSec / 60).toFixed(1)} min)\n`)
  process.stdout.write(`Cutting ${chapters.length} pieces into assets/music/\n\n`)

  for (const [i, chapter] of chapters.entries()) {
    const start = toSeconds(chapter.at)
    const end = i + 1 < chapters.length ? toSeconds(chapters[i + 1].at) : totalSec
    const length = end - start
    const name = `${String(i + 1).padStart(2, '0')}-${slugify(chapter.title)}.m4a`
    const outFile = path.join(outDir, name)

    /**
     * Measure the piece before cutting it, to find out what "quiet" means for it.
     *
     * Chapter marks land where a title changes, not where the sound starts, and
     * several pieces here open with seconds of near-silence - the one picked first
     * had five. Under a one-minute tutorial that lead-in is most of the opening. It
     * is also invisible to an EBU R128 measurement, which gates quiet passages out
     * and reports the piece as perfectly healthy, so it has to be looked for
     * deliberately.
     *
     * A fixed threshold does not work, because a track's own level sets what counts
     * as silence: -45 dB left a piece averaging -55 dB in its first three seconds
     * untouched. Twelve dB below the piece's own average does work, and adapts to
     * whatever is fed in later.
     */
    const { stderr: levels } = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats',
      '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', source,
      '-vn', '-af', 'volumedetect', '-f', 'null', '-',
    ])
    const meanDb = Number(levels.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)?.[1] ?? NaN)
    const floor = Number.isFinite(meanDb) ? (meanDb - 12).toFixed(1) : '-45'

    // Re-encoded rather than stream-copied: a copy cuts on the nearest packet
    // boundary, which leaves a fragment of the previous piece at the start.
    //
    // The fades are 40 ms, just enough to stop the cut clicking. Longer ones were
    // tried and are wrong: composition fades the music in and out on its own, so a
    // musical fade here lands on top of that one.
    await run(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', source,
      '-vn', '-af',
      `silenceremove=start_periods=1:start_threshold=${floor}dB:start_silence=0.15,` +
        'afade=t=in:st=0:d=0.04,areverse,afade=t=in:st=0:d=0.04,areverse',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
      outFile,
    ])
    process.stdout.write(
      `  ${name.padEnd(38)} ${Math.floor(length / 60)}:${String(Math.round(length % 60)).padStart(2, '0')}\n`,
    )
  }

  process.stdout.write(`\nDone. ${chapters.length} tracks in assets/music/\n`)
}

main().catch(err => {
  process.stderr.write(`\nsplit-music failed: ${err.stack ?? err.message}\n`)
  process.exit(1)
})
