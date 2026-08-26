/**
 * Environment discovery and configuration.
 *
 * Everything the server needs from the outside world is resolved here once, so the
 * rest of the code can assume it has working paths. Nothing in this module throws
 * on a missing optional dependency - the `doctor` command reports what is missing
 * and individual features fail with a clear message when they are actually used.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Repository root, i.e. the parent of `dist/`. */
export const PROJECT_ROOT = path.resolve(HERE, '..', '..')

export interface Paths {
  /** Where browser profiles carrying the user's logins live. */
  profiles: string
  /** Where finished tutorials and their working files are written. */
  recordings: string
  /** Bundled media assets (background music, branding). */
  assets: string
  /** Cache for rendered narration audio. */
  ttsCache: string
}

export interface Config {
  paths: Paths
  ffmpegPath: string | null
  ffprobePath: string | null
  chromiumPath: string | null
  elevenLabsApiKey: string | null
  defaultVoiceId: string
  defaultModelId: string
  defaultMusic: string | null
}

/**
 * Resolve a binary by walking PATH.
 *
 * This deliberately does not execute the binary to test it. Doing that cost about
 * seven seconds of start-up on this machine - long enough for an MCP client to give
 * up on the server - because ffmpeg and ffprobe are slow to launch and verbose.
 * Existence on PATH is enough; `doctor` runs them properly when asked.
 */
function which(binary: string): string | null {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : ['']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
      } catch {
        // unreadable PATH entry - skip it
      }
    }
  }
  return null
}

/**
 * Playwright ships its own Chromium (and an ffmpeg used for its video recording).
 * We reuse the browser it already downloaded rather than asking for another one.
 */
function findPlaywrightBrowser(): string | null {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter((r): r is string => Boolean(r))

  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const builds = fs
      .readdirSync(root)
      .filter(name => name.startsWith('chromium-'))
      // highest build number wins
      .sort((a, b) => Number(b.split('-')[1] ?? 0) - Number(a.split('-')[1] ?? 0))

    for (const build of builds) {
      const exe =
        process.platform === 'win32'
          ? path.join(root, build, 'chrome-win64', 'chrome.exe')
          : process.platform === 'darwin'
            ? path.join(root, build, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
            : path.join(root, build, 'chrome-linux', 'chrome')
      if (fs.existsSync(exe)) return exe
    }
  }
  return null
}

/** Pick the first background-music file present in `assets/music`. */
function findDefaultMusic(assetsDir: string): string | null {
  const dir = path.join(assetsDir, 'music')
  if (!fs.existsSync(dir)) return null
  const audio = fs
    .readdirSync(dir)
    .filter(f => /\.(m4a|mp3|aac|wav|flac|ogg|opus)$/i.test(f))
    .sort()
  const first = audio[0]
  return first ? path.join(dir, first) : null
}

let cached: Config | null = null

export function loadConfig(): Config {
  if (cached) return cached

  const home = process.env.TUTORIAL_MCP_HOME
    ? path.resolve(process.env.TUTORIAL_MCP_HOME)
    : PROJECT_ROOT

  const assets = path.join(PROJECT_ROOT, 'assets')
  const paths: Paths = {
    profiles: path.join(home, 'profiles'),
    recordings: path.join(home, 'recordings'),
    assets,
    ttsCache: path.join(home, 'tmp', 'tts-cache'),
  }

  for (const dir of Object.values(paths)) {
    if (dir !== assets) fs.mkdirSync(dir, { recursive: true })
  }

  cached = {
    paths,
    ffmpegPath: process.env.FFMPEG_PATH ?? which('ffmpeg'),
    ffprobePath: process.env.FFPROBE_PATH ?? which('ffprobe'),
    chromiumPath: process.env.TUTORIAL_MCP_CHROMIUM ?? findPlaywrightBrowser(),
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? null,
    // "Rachel" - a calm, even narrator from the ElevenLabs default library.
    defaultVoiceId: process.env.TUTORIAL_MCP_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM',
    defaultModelId: process.env.TUTORIAL_MCP_MODEL_ID ?? 'eleven_multilingual_v2',
    defaultMusic: process.env.TUTORIAL_MCP_MUSIC ?? findDefaultMusic(assets),
  }
  return cached
}

/** Throw a readable error when a required external tool is absent. */
export function requireFfmpeg(config: Config): string {
  if (!config.ffmpegPath) {
    throw new Error(
      'ffmpeg was not found. Install it and put it on PATH, or set FFMPEG_PATH to its full path.',
    )
  }
  return config.ffmpegPath
}

export function requireFfprobe(config: Config): string {
  if (!config.ffprobePath) {
    throw new Error(
      'ffprobe was not found. It ships with ffmpeg; put it on PATH or set FFPROBE_PATH.',
    )
  }
  return config.ffprobePath
}

export function requireElevenLabsKey(config: Config): string {
  if (!config.elevenLabsApiKey) {
    throw new Error(
      'No ElevenLabs API key. Set ELEVENLABS_API_KEY in the MCP server environment to render narration.',
    )
  }
  return config.elevenLabsApiKey
}

/** Turn a title into a filesystem-safe slug used for the output folder name. */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'tutorial'
}
