/**
 * Narration via the ElevenLabs text-to-speech API.
 *
 * Rendered audio is cached on disk under a hash of everything that affects the
 * result, so re-recording a tutorial after fixing one sentence only pays for the
 * sentence that changed.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './env.js'
import { requireElevenLabsKey, requireFfprobe } from './env.js'
import { probeDuration } from './ffmpeg.js'
import { log } from './logger.js'

const API_ROOT = 'https://api.elevenlabs.io/v1'

/**
 * Turn an ElevenLabs error response into something actionable.
 *
 * Their errors carry a `detail.message` that usually says exactly what is wrong -
 * for instance that a key ID was pasted where the key belongs. Swallowing it and
 * reporting only the status code wastes the diagnosis they handed over.
 */
async function describeApiError(response: Response, action: string): Promise<Error> {
  const body = await response.text().catch(() => '')
  let message = body.slice(0, 400)
  try {
    const parsed = JSON.parse(body) as { detail?: { message?: string } | string }
    if (typeof parsed.detail === 'string') message = parsed.detail
    else if (parsed.detail?.message) message = parsed.detail.message
  } catch {
    // not JSON - keep the raw text
  }
  return new Error(
    `ElevenLabs refused to ${action} (HTTP ${response.status}). ${message}`.trim(),
  )
}

/** Cheap sanity check on the API key shape before spending a request. */
export function looksLikeApiKey(key: string): boolean {
  return key.startsWith('sk_')
}

export interface VoiceSettings {
  stability: number
  similarity_boost: number
  style: number
  use_speaker_boost: boolean
  speed?: number
}

/**
 * Calm, evenly paced instructional read: high stability keeps the delivery steady
 * across many short lines, low style keeps it from performing.
 */
export const TUTORIAL_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.55,
  similarity_boost: 0.75,
  style: 0.1,
  use_speaker_boost: true,
}

export interface SynthesisRequest {
  text: string
  voiceId: string
  modelId: string
  settings?: VoiceSettings
}

export interface SynthesisResult {
  file: string
  durationMs: number
  cached: boolean
}

function cacheKey(request: SynthesisRequest): string {
  const settings = request.settings ?? TUTORIAL_VOICE_SETTINGS
  const material = JSON.stringify([
    request.text.trim(),
    request.voiceId,
    request.modelId,
    settings.stability,
    settings.similarity_boost,
    settings.style,
    settings.use_speaker_boost,
    settings.speed ?? null,
  ])
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)
}

/**
 * Rough spoken duration, used only when no API key is configured so the rest of
 * the pipeline stays testable. ~155 words per minute is a normal narration pace.
 */
export function estimateSpokenMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.max(700, Math.round((words / 155) * 60_000) + 350)
}

export async function synthesise(
  config: Config,
  request: SynthesisRequest,
): Promise<SynthesisResult> {
  const apiKey = requireElevenLabsKey(config)
  const key = cacheKey(request)
  fs.mkdirSync(config.paths.ttsCache, { recursive: true })
  const file = path.join(config.paths.ttsCache, `${key}.mp3`)

  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const seconds = await probeDuration(requireFfprobe(config), file)
    if (seconds) {
      return { file, durationMs: Math.round(seconds * 1000), cached: true }
    }
  }

  const url =
    `${API_ROOT}/text-to-speech/${encodeURIComponent(request.voiceId)}` +
    `?output_format=mp3_44100_128`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: request.text,
      model_id: request.modelId,
      voice_settings: request.settings ?? TUTORIAL_VOICE_SETTINGS,
    }),
  })

  if (!response.ok) throw await describeApiError(response, 'synthesise narration')

  const audio = Buffer.from(await response.arrayBuffer())
  if (audio.length === 0) throw new Error('ElevenLabs returned an empty audio response.')
  fs.writeFileSync(file, audio)

  const seconds = await probeDuration(requireFfprobe(config), file)
  const durationMs = seconds ? Math.round(seconds * 1000) : estimateSpokenMs(request.text)
  log.info(`Narrated ${audio.length} bytes / ${durationMs}ms: "${request.text.slice(0, 60)}"`)

  return { file, durationMs, cached: false }
}

export interface Voice {
  voiceId: string
  name: string
  category: string
  description: string | null
  labels: Record<string, string>
}

export async function listVoices(config: Config): Promise<Voice[]> {
  const apiKey = requireElevenLabsKey(config)
  const response = await fetch(`${API_ROOT}/voices`, { headers: { 'xi-api-key': apiKey } })
  if (!response.ok) throw await describeApiError(response, 'list voices')
  const data = (await response.json()) as {
    voices?: Array<{
      voice_id: string
      name: string
      category?: string
      description?: string | null
      labels?: Record<string, string>
    }>
  }
  return (data.voices ?? []).map(v => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category ?? 'unknown',
    description: v.description ?? null,
    labels: v.labels ?? {},
  }))
}
