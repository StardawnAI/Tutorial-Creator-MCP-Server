/**
 * A person who speaks the narration, through HeyGen.
 *
 * The narration is always an audio file this server holds, and the look is lip-synced
 * *to that file*. Where the file comes from is a choice: ElevenLabs by default, or
 * HeyGen's own speech endpoint (`speakWithHeyGen`). Either answers in about a second,
 * which is what the recording needs - it waits out every line in real time.
 *
 * What can never be in that loop is the avatar render itself, which takes minutes.
 * Hence the split: speak now, put a face on it afterwards.
 *
 * Clips are rendered after the recording, not during it. A render takes a minute or
 * more, and the recording waits out every line in real time - asking for the avatar
 * mid-recording would put that minute into the video.
 *
 * This is the v3 API (`POST /v3/videos`). The v2 endpoints still answer but are
 * retired on 2026-10-31.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './env.js'
import { requireFfmpeg, requireFfprobe, requireHeyGenKey } from './env.js'
import { probeDuration, run } from './ffmpeg.js'
import { log } from './logger.js'

const API_ROOT = 'https://api.heygen.com/v3'

/** A page of looks; the API refuses more than this. */
const PAGE_SIZE = 50
/** How many pages a search by name walks before giving up. */
const SEARCH_PAGES = 20

const POLL_INTERVAL_MS = 5_000
const RENDER_TIMEOUT_MS = 600_000
/** Renders in flight at once. Enough to overlap, few enough to stay polite. */
const CONCURRENCY = 3

/** Preferred engine, and what to fall back to if a look does not support it. */
const ENGINE_PREFERENCE = ['avatar_iv', 'avatar_iii', 'avatar_v']

/** An avatar look: one outfit and setting of one avatar. */
export interface AvatarLook {
  id: string
  name: string
  groupId: string | null
  /** `photo_avatar`, `digital_twin`, ... */
  type: string
  engines: string[]
}

/** One rendered line: the avatar saying it, and where it belongs in the video. */
export interface AvatarClip {
  file: string
  atMs: number
  durationMs: number
}

export function canRenderAvatar(config: Config): boolean {
  return Boolean(config.heygenApiKey)
}

/** 32 hex characters - a look id, a group id, or an asset id. */
function looksLikeId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value.trim())
}

/**
 * One HTTP call, with the errors turned into something a reader can act on.
 *
 * Connections to this API drop often enough on a home line that a single failed
 * `fetch` must not end a render - so network failures are retried, while an answer
 * from the server, including a refusal, is returned as it is.
 */
async function call(
  config: Config,
  url: string,
  init: RequestInit = {},
  attempts = 3,
): Promise<{ status: number; body: any; text: string }> {
  const apiKey = requireHeyGenKey(config)
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { 'X-Api-Key': apiKey, accept: 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(120_000),
      })
      const text = await response.text()
      let body: any = null
      try {
        body = JSON.parse(text)
      } catch {
        // not JSON - the caller gets the text instead
      }
      return { status: response.status, body, text }
    } catch (err) {
      lastError = err as Error
      log.warn(`HeyGen request failed (attempt ${attempt}/${attempts}): ${lastError.message}`)
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 3000 * attempt))
    }
  }
  throw new Error(`HeyGen could not be reached: ${lastError?.message ?? 'unknown error'}`)
}

/** Turn a refusal into a sentence that says what to do about it. */
function describeError(status: number, body: any, action: string): Error {
  const code = body?.error?.code ?? ''
  const message = body?.error?.message ?? body?.message ?? ''

  if (code === 'insufficient_credit') {
    return new Error(
      `HeyGen has no credit left, so it will not ${action}. Top the account up at ` +
        'app.heygen.com (Billing); nothing else about the recording is affected.',
    )
  }
  if (status === 401 || status === 403) {
    return new Error(`HeyGen rejected the API key (HTTP ${status}). Check HEYGEN_API_KEY.`)
  }
  return new Error(`HeyGen refused to ${action} (HTTP ${status}). ${code} ${message}`.trim())
}

function toLook(entry: any): AvatarLook {
  return {
    id: String(entry.id ?? entry.avatar_id ?? ''),
    name: String(entry.name ?? entry.avatar_name ?? 'unnamed'),
    groupId: entry.group_id ?? null,
    type: String(entry.avatar_type ?? 'avatar'),
    engines: Array.isArray(entry.supported_api_engines) ? entry.supported_api_engines : [],
  }
}

/**
 * Looks on the account, newest first.
 *
 * `search` matches part of a name and is applied here rather than by the API, which
 * offers no name filter - so a search walks pages until it has enough matches.
 */
export async function listLooks(
  config: Config,
  options: { search?: string; groupId?: string; limit?: number } = {},
): Promise<AvatarLook[]> {
  const wanted = options.search?.trim().toLowerCase()
  const limit = options.limit ?? 40
  const found: AvatarLook[] = []
  let token: string | null = null

  for (let page = 0; page < (wanted ? SEARCH_PAGES : 1); page++) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (options.groupId) query.set('group_id', options.groupId)
    if (token) query.set('token', token)

    const { status, body } = await call(config, `${API_ROOT}/avatars/looks?${query}`)
    if (status !== 200) throw describeError(status, body, 'list the avatar looks')

    for (const entry of body.data ?? []) {
      const look = toLook(entry)
      if (!wanted || look.name.toLowerCase().includes(wanted)) found.push(look)
      if (found.length >= limit) return found
    }

    if (!body.has_more || !body.next_token) break
    token = body.next_token as string
  }
  return found
}

/**
 * Turn what the caller typed into one look.
 *
 * Three things are accepted, because all three are things a person actually has to
 * hand: a look id, the group id out of the app's URL (`/avatar/my-avatars/<id>`),
 * and part of a look's name.
 */
export async function resolveLook(config: Config, query: string): Promise<AvatarLook> {
  const trimmed = query.trim()

  if (looksLikeId(trimmed)) {
    const direct = await call(config, `${API_ROOT}/avatars/looks/${trimmed}`)
    if (direct.status === 200 && direct.body?.data) return toLook(direct.body.data)

    // Not a look, so try it as the group the app URL names.
    const group = await listLooks(config, { groupId: trimmed, limit: PAGE_SIZE })
    if (group.length === 1) return group[0] as AvatarLook
    if (group.length > 1) {
      throw new Error(
        `${trimmed} is an avatar group with ${group.length} looks. Name one of them:\n` +
          group.map(l => `  ${l.name}  [${l.id}]`).join('\n'),
      )
    }
    throw new Error(`HeyGen knows no avatar look or group with the id ${trimmed}.`)
  }

  const matches = await listLooks(config, { search: trimmed, limit: 12 })
  if (matches.length === 0) {
    throw new Error(
      `No avatar look on this account matches "${trimmed}". List them with tutorial_avatars, ` +
        'or pass a look id.',
    )
  }
  if (matches.length > 1) {
    const exact = matches.find(l => l.name.toLowerCase() === trimmed.toLowerCase())
    if (exact) return exact
    log.info(`"${trimmed}" matched ${matches.length} looks; using "${matches[0]?.name}"`)
  }
  return matches[0] as AvatarLook
}

/** What the account can still spend, in its own currency, or null if unknown. */
export async function remainingBalance(config: Config): Promise<number | null> {
  const { status, body } = await call(config, `${API_ROOT}/users/me`)
  if (status !== 200) return null
  const balance = body?.data?.wallet?.remaining_balance
  return typeof balance === 'number' ? balance : null
}

/** Upload one narration clip and return the asset id HeyGen speaks from. */
async function uploadAudio(config: Config, file: string): Promise<string> {
  const form = new FormData()
  const bytes = fs.readFileSync(file)
  // MP3 and WAV are what the asset endpoint takes; the silence for an idle clip is
  // WAV, because this ffmpeg build cannot write MP3 (no libmp3lame).
  const type = file.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
  form.append('file', new Blob([bytes], { type }), path.basename(file))

  const { status, body } = await call(config, `${API_ROOT}/assets`, { method: 'POST', body: form })
  const assetId = body?.data?.asset_id ?? body?.asset_id
  if (status !== 200 || !assetId) throw describeError(status, body, 'accept the narration audio')
  return String(assetId)
}

/** The video URL in a finished job, wherever the answer carries it. */
function findVideoUrl(node: unknown): string | null {
  if (typeof node === 'string') {
    return /^https?:\/\/\S+\.(mp4|webm)(\?|$)/i.test(node) ? node : null
  }
  if (!node || typeof node !== 'object') return null
  const record = node as Record<string, unknown>
  for (const key of ['video_url', 'url', 'output_url']) {
    const found = findVideoUrl(record[key])
    if (found) return found
  }
  for (const value of Object.values(record)) {
    const found = findVideoUrl(value)
    if (found) return found
  }
  return null
}

function engineFor(look: AvatarLook): string {
  const supported = ENGINE_PREFERENCE.find(engine => look.engines.includes(engine))
  return supported ?? ENGINE_PREFERENCE[0]!
}

/**
 * Render one line: the look saying exactly the audio in `audioFile`.
 *
 * A square 720p frame, because the clip ends up as a round bubble in the corner of
 * the tutorial - asking for a wide frame would only mean more pixels to throw away.
 */
export async function renderClip(
  config: Config,
  options: { audioFile: string; look: AvatarLook; outFile: string; title?: string },
): Promise<string> {
  const assetId = await uploadAudio(config, options.audioFile)

  const created = await call(config, `${API_ROOT}/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'avatar',
      avatar_id: options.look.id,
      audio_asset_id: assetId,
      engine: { type: engineFor(options.look) },
      resolution: '720p',
      aspect_ratio: '1:1',
      // Fill the square from whatever shape the look is, rather than letterboxing it.
      fit: 'cover',
      title: options.title ?? 'Tutorial narration',
    }),
  })
  const videoId = created.body?.data?.video_id ?? created.body?.video_id
  if (created.status !== 200 || !videoId) {
    throw describeError(created.status, created.body, 'render the avatar')
  }

  const started = Date.now()
  let videoUrl: string | null = null
  while (Date.now() - started < RENDER_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    const { status, body } = await call(config, `${API_ROOT}/videos/${videoId}`)
    if (status !== 200) throw describeError(status, body, 'report on the avatar render')

    const state = String(body?.data?.status ?? body?.status ?? '')
    if (state === 'completed' || state === 'success') {
      videoUrl = findVideoUrl(body)
      if (!videoUrl) throw new Error('HeyGen reported the avatar finished but returned no video.')
      break
    }
    if (state === 'failed' || state === 'error') {
      const reason =
        body?.data?.error?.message ?? body?.data?.error ?? body?.error?.message ?? 'no reason given'
      throw new Error(`HeyGen could not render the avatar: ${JSON.stringify(reason)}`)
    }
  }
  if (!videoUrl) throw new Error('HeyGen did not finish the avatar within ten minutes.')

  const download = await fetch(videoUrl, { signal: AbortSignal.timeout(180_000) })
  if (!download.ok) throw new Error(`Downloading the avatar clip failed (HTTP ${download.status}).`)
  const video = Buffer.from(await download.arrayBuffer())
  if (video.length === 0) throw new Error('HeyGen returned an empty avatar clip.')
  fs.mkdirSync(path.dirname(options.outFile), { recursive: true })
  fs.writeFileSync(options.outFile, video)
  return options.outFile
}

/**
 * The avatar standing there saying nothing, to fill the gaps between lines.
 *
 * Rendered from silence, which is the only way to get idle footage of a look: there
 * is no "just stand there" endpoint, but a clip is made from whatever audio it is
 * given, and silent audio gives a person who breathes and blinks and does not speak.
 * One of these is rendered per recording and looped under every gap.
 */
export async function renderIdleClip(
  config: Config,
  options: { look: AvatarLook; outFile: string; seconds?: number },
): Promise<string> {
  const seconds = options.seconds ?? 10
  const silence = path.join(config.paths.avatarCache, `silence-${seconds}s.wav`)
  if (!fs.existsSync(silence)) {
    fs.mkdirSync(config.paths.avatarCache, { recursive: true })
    await run(requireFfmpeg(config), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono`,
      '-t', String(seconds), '-c:a', 'pcm_s16le', silence,
    ])
  }

  const cached = path.join(
    config.paths.avatarCache,
    `idle-${options.look.id}-${engineFor(options.look)}-${seconds}s.mp4`,
  )
  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
    fs.mkdirSync(path.dirname(options.outFile), { recursive: true })
    fs.copyFileSync(cached, options.outFile)
    return options.outFile
  }

  log.info(`Rendering ${seconds}s of idle avatar for the gaps between lines`)
  await renderClip(config, {
    audioFile: silence,
    look: options.look,
    outFile: cached,
    title: 'Idle',
  })
  fs.mkdirSync(path.dirname(options.outFile), { recursive: true })
  fs.copyFileSync(cached, options.outFile)
  return options.outFile
}

/**
 * A line spoken by a HeyGen voice, as an audio file plus its length.
 *
 * The same shape ElevenLabs narration has, on purpose: the recording needs the audio
 * and its exact duration *while it is recording*, because it waits out every line in
 * real time. Both services answer in about a second, so either can drive the
 * recording - what could never drive it is the avatar render itself, which takes
 * minutes.
 */
export async function speakWithHeyGen(
  config: Config,
  request: { text: string; voiceId: string; speed?: number },
): Promise<{ file: string; durationMs: number; cached: boolean }> {
  fs.mkdirSync(config.paths.ttsCache, { recursive: true })
  const key = crypto
    .createHash('sha256')
    .update(['heygen', request.text.trim(), request.voiceId, request.speed ?? 1].join('|'))
    .digest('hex')
    .slice(0, 32)
  const file = path.join(config.paths.ttsCache, `${key}.mp3`)

  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const seconds = await probeDuration(requireFfprobe(config), file)
    if (seconds) return { file, durationMs: Math.round(seconds * 1000), cached: true }
  }

  const { status, body } = await call(config, `${API_ROOT}/voices/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: request.text,
      voice_id: request.voiceId,
      speed: request.speed ?? 1,
    }),
  })
  const url = body?.data?.audio_url
  if (status !== 200 || !url) throw describeError(status, body, 'speak the line')

  const download = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!download.ok) throw new Error(`Downloading the spoken line failed (HTTP ${download.status}).`)
  fs.writeFileSync(file, Buffer.from(await download.arrayBuffer()))

  const reported = Number(body?.data?.duration)
  const seconds = Number.isFinite(reported) && reported > 0
    ? reported
    : ((await probeDuration(requireFfprobe(config), file)) ?? 0)
  return { file, durationMs: Math.round(seconds * 1000), cached: false }
}

/** Voices the speech endpoint accepts; it only takes ones on the "starfish" engine. */
export async function listSpeechVoices(
  config: Config,
  options: { search?: string; limit?: number } = {},
): Promise<Array<{ voiceId: string; name: string; language: string; gender: string }>> {
  const wanted = options.search?.trim().toLowerCase()
  const limit = options.limit ?? 40
  const found: Array<{ voiceId: string; name: string; language: string; gender: string }> = []
  let token: string | null = null

  for (let page = 0; page < (wanted ? SEARCH_PAGES : 1); page++) {
    const query = new URLSearchParams({ engine: 'starfish', limit: String(PAGE_SIZE) })
    if (token) query.set('token', token)
    const { status, body } = await call(config, `${API_ROOT}/voices?${query}`)
    if (status !== 200) throw describeError(status, body, 'list the voices')

    for (const entry of body.data ?? []) {
      const voice = {
        voiceId: String(entry.voice_id ?? ''),
        name: String(entry.name ?? 'unnamed'),
        language: String(entry.language ?? ''),
        gender: String(entry.gender ?? ''),
      }
      if (!wanted || `${voice.name} ${voice.language}`.toLowerCase().includes(wanted)) {
        found.push(voice)
      }
      if (found.length >= limit) return found
    }
    if (!body.has_more || !body.next_token) break
    token = body.next_token as string
  }
  return found
}

/** Cache key: the audio, the look and the engine - everything that shapes the clip. */
function cacheKey(audioFile: string, look: AvatarLook): string {
  const audio = crypto.createHash('sha256').update(fs.readFileSync(audioFile)).digest('hex')
  return crypto
    .createHash('sha256')
    .update([audio, look.id, engineFor(look), '720p', '1:1'].join('|'))
    .digest('hex')
    .slice(0, 32)
}

export interface AvatarLine {
  audioFile: string
  atMs: number
  durationMs: number
  text: string
}

/**
 * Render every narrated line, a few at a time.
 *
 * A finished clip is kept under its audio's hash, so re-composing a recording - or
 * fixing one line and running it again - costs nothing at HeyGen. A line that fails
 * is left out rather than failing the video: the tutorial is still worth having with
 * one bubble missing.
 */
export async function renderAvatarClips(
  config: Config,
  lines: AvatarLine[],
  options: { look: AvatarLook; outDir: string },
): Promise<{ clips: AvatarClip[]; failures: string[] }> {
  fs.mkdirSync(options.outDir, { recursive: true })
  fs.mkdirSync(config.paths.avatarCache, { recursive: true })

  const clips: AvatarClip[] = []
  const failures: string[] = []
  const queue = [...lines.entries()]

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      const [index, line] = next

      const cached = path.join(config.paths.avatarCache, `${cacheKey(line.audioFile, options.look)}.mp4`)
      const local = path.join(options.outDir, `${String(index).padStart(3, '0')}.mp4`)
      try {
        if (!fs.existsSync(cached) || fs.statSync(cached).size === 0) {
          log.info(`Avatar ${index + 1}/${lines.length}: "${line.text.slice(0, 50)}"`)
          await renderClip(config, {
            audioFile: line.audioFile,
            look: options.look,
            outFile: cached,
            title: line.text.slice(0, 60),
          })
        } else {
          log.info(`Avatar ${index + 1}/${lines.length}: already rendered`)
        }
        fs.copyFileSync(cached, local)
        clips.push({ file: local, atMs: line.atMs, durationMs: line.durationMs })
      } catch (err) {
        const reason = (err as Error).message
        failures.push(`line ${index + 1}: ${reason}`)
        log.warn(`Avatar for line ${index + 1} failed: ${reason}`)
        // One refusal for credit or key means every other line will fail the same way.
        if (/no credit left|rejected the API key/.test(reason)) {
          queue.length = 0
          return
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, lines.length) }, worker))
  clips.sort((a, b) => a.atMs - b.atMs)
  return { clips, failures }
}
