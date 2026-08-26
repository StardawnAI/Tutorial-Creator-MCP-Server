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

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `ElevenLabs returned ${response.status} ${response.statusText}. ${detail.slice(0, 500)}`,
    )
  }

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
  if (!response.ok) {
    throw new Error(`ElevenLabs returned ${response.status} while listing voices.`)
  }
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
