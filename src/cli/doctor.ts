#!/usr/bin/env node
/**
 * Environment check. Reports what is present and what would block a recording.
 * Exits non-zero only when something is genuinely required and missing.
 */

import fs from 'node:fs'
import { loadConfig } from '../lib/env.js'
import { probeDuration, run } from '../lib/ffmpeg.js'

const TICK = '  ok  '
const CROSS = ' FAIL '
const WARN = ' warn '

async function main(): Promise<void> {
  const config = loadConfig()
  const problems: string[] = []
  const warnings: string[] = []
  const lines: string[] = ['Tutorial Creator - environment check', '']

  // ffmpeg / ffprobe
  if (config.ffmpegPath) {
    const { stdout, stderr } = await run(config.ffmpegPath, ['-version']).catch(() => ({
      stdout: '',
      stderr: '',
    }))
    const version = `${stdout}${stderr}`.split('\n')[0] ?? 'unknown'
    lines.push(`[${TICK}] ffmpeg    ${version}`)
  } else {
    lines.push(`[${CROSS}] ffmpeg    not found on PATH (set FFMPEG_PATH)`)
    problems.push('ffmpeg is required to render video.')
  }

  lines.push(
    config.ffprobePath
      ? `[${TICK}] ffprobe   ${config.ffprobePath}`
      : `[${CROSS}] ffprobe   not found (set FFPROBE_PATH)`,
  )
  if (!config.ffprobePath) problems.push('ffprobe is required to measure audio and video.')

  // Required ffmpeg filters
  if (config.ffmpegPath) {
    const { stdout } = await run(config.ffmpegPath, ['-hide_banner', '-filters']).catch(() => ({
      stdout: '',
      stderr: '',
    }))
    const needed = ['adelay', 'amix', 'sidechaincompress', 'loudnorm', 'afade', 'anullsrc', 'tpad']
    const missing = needed.filter(f => !new RegExp(`\\b${f}\\b`).test(stdout))
    lines.push(
      missing.length === 0
        ? `[${TICK}] filters   all required audio filters present`
        : `[${CROSS}] filters   missing: ${missing.join(', ')}`,
    )
    if (missing.length > 0) problems.push(`ffmpeg build lacks: ${missing.join(', ')}`)
  }

  // Chromium
  if (config.chromiumPath && fs.existsSync(config.chromiumPath)) {
    lines.push(`[${TICK}] chromium  ${config.chromiumPath}`)
  } else {
    lines.push(`[${CROSS}] chromium  not found - run: npx playwright install chromium`)
    problems.push('A Chromium build is required to record.')
  }

  // ElevenLabs
  if (config.elevenLabsApiKey) {
    lines.push(`[${TICK}] narration ELEVENLABS_API_KEY is set (voice ${config.defaultVoiceId})`)
  } else {
    lines.push(`[${WARN}] narration no ELEVENLABS_API_KEY - recordings will be silent`)
    warnings.push(
      'Set ELEVENLABS_API_KEY to get spoken narration. Without it, recordings are still ' +
        'paced correctly and subtitles are written, but there is no voice.',
    )
  }

  // Music
  if (config.defaultMusic && fs.existsSync(config.defaultMusic)) {
    const seconds = config.ffprobePath
      ? await probeDuration(config.ffprobePath, config.defaultMusic).catch(() => null)
      : null
    lines.push(
      `[${TICK}] music     ${config.defaultMusic}` +
        (seconds ? ` (${Math.round(seconds / 60)} min)` : ''),
    )
  } else {
    lines.push(`[${WARN}] music     none found in assets/music`)
    warnings.push('Drop an audio file into assets/music to get background music.')
  }

  // Profiles
  const profiles = fs.existsSync(config.paths.profiles)
    ? fs.readdirSync(config.paths.profiles, { withFileTypes: true }).filter(d => d.isDirectory())
    : []
  if (profiles.length > 0) {
    lines.push(`[${TICK}] profiles  ${profiles.map(p => p.name).join(', ')}`)
  } else {
    lines.push(`[${WARN}] profiles  none yet - run "npm run login" to sign in to a site`)
    warnings.push('Recordings of signed-in apps need a profile that is logged in.')
  }

  lines.push('', `output:    ${config.paths.recordings}`)

  if (warnings.length > 0) {
    lines.push('', 'Notes:')
    lines.push(...warnings.map(w => `  - ${w}`))
  }
  if (problems.length > 0) {
    lines.push('', 'Blocking problems:')
    lines.push(...problems.map(p => `  - ${p}`))
  }

  process.stdout.write(`${lines.join('\n')}\n`)
  process.exit(problems.length > 0 ? 1 : 0)
}

main().catch(err => {
  process.stderr.write(`doctor failed: ${(err as Error).message}\n`)
  process.exit(1)
})
