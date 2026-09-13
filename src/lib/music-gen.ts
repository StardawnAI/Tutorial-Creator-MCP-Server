/**
 * Background music composed for the video, through Google's Lyria model.
 *
 * The track library stays the default. This is the second path: a piece written to
 * the length of this particular video, so it neither loops nor gets cut off mid-phrase,
 * and so two tutorials do not sound alike.
 *
 * The brief is fixed on purpose. Music under a narrated tutorial has one job - to make
 * the silence between sentences feel intended - and it fails the moment it competes
 * with the voice. So every request asks for the same character (serious, calm, warmly
 * supportive, instrumental, no sudden changes) and only the instrumentation varies.
 */

import fs from 'node:fs'
import type { Config } from './env.js'
import { log } from './logger.js'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions'
const MODEL = 'lyria-3.5'

/** Instrumentations rotated between videos. Every one keeps out of the voice's way. */
const PALETTES = [
  'soft felt piano over warm, slowly moving string pads',
  'gentle electric piano with a light brushed pulse and a round, quiet bass',
  'clean ambient guitar arpeggios over airy synth pads',
  'warm analogue synth textures with a slow, steady arpeggio',
  'muted marimba and soft pads over a calm, even pulse',
]

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The request text: the fixed character, the instrumentation, and a timed structure. */
export function musicPrompt(seconds: number, palette: string): string {
  const total = Math.max(30, Math.round(seconds))
  const intro = Math.min(10, Math.round(total * 0.1))
  const outro = Math.max(intro + 10, total - 12)
  return [
    `Instrumental background music for a narrated software tutorial video, exactly ${clock(total)} long.`,
    'Instrumental only, no vocals, no lyrics.',
    'Serious, calm and warmly supportive. It accompanies a narrator explaining each step, ' +
      'so it stays unobtrusive: soft dynamics, sparse in the middle frequencies where the ' +
      'voice sits, no sudden changes, no drops, no big build-ups, nothing playful.',
    `Instrumentation: ${palette}. Around 80 to 95 BPM.`,
    `[0:00 - ${clock(intro)}] Intro: a gentle entry that settles in quickly.`,
    `[${clock(intro)} - ${clock(outro)}] Main: an even, steady bed with small, slow variations, so it never sounds like a loop.`,
    `[${clock(outro)} - ${clock(total)}] Outro: winds down and ends softly on a resolved chord.`,
  ].join('\n')
}

export function canGenerateMusic(config: Config): boolean {
  return Boolean(config.geminiApiKey || config.googleOAuth)
}

/** Credentials for one request: an API key, or a fresh access token from the stored grant. */
async function authHeaders(config: Config): Promise<Record<string, string>> {
  if (config.geminiApiKey) return { 'x-goog-api-key': config.geminiApiKey }
  if (!config.googleOAuth) {
    throw new Error(
      'No Google access for music generation. Set GEMINI_API_KEY, or GOOGLE_OAUTH_CLIENT_FILE ' +
        'together with GOOGLE_OAUTH_REFRESH_TOKEN.',
    )
  }

  const file = JSON.parse(fs.readFileSync(config.googleOAuth.clientFile, 'utf8'))
  const client = file.web ?? file.installed
  const res = await fetch(client.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: config.googleOAuth.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const body = (await res.json()) as { access_token?: string; error?: string }
  if (!res.ok || !body.access_token) {
    throw new Error(`Google refused the stored authorisation (HTTP ${res.status} ${body.error ?? ''})`)
  }
  // A user's token is billed to a project only when the request names one.
  return { authorization: `Bearer ${body.access_token}`, 'x-goog-user-project': client.project_id }
}

/**
 * The base64 audio anywhere in the answer.
 *
 * Documented as `steps[].content[]` with `type: "audio"`, and as `output_audio` in the
 * SDKs. Searched for rather than addressed, so a shift between the two does not turn
 * a finished piece of music into an error.
 */
function findAudio(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null
  const record = node as Record<string, unknown>
  const mime = String(record.mime_type ?? record.mimeType ?? '')
  if (typeof record.data === 'string' && (record.type === 'audio' || mime.startsWith('audio/'))) {
    return record.data
  }
  for (const value of Object.values(record)) {
    const found = findAudio(value)
    if (found) return found
  }
  return null
}

export interface GeneratedMusic {
  file: string
  palette: string
  prompt: string
}

/**
 * Compose a piece for a video `seconds` long and write it to `outFile`.
 *
 * A few seconds more than the video are asked for: the mix trims and fades an overlong
 * track cleanly, while a short one would have to loop, and the seam would be heard.
 */
export async function generateMusic(
  config: Config,
  options: { seconds: number; outFile: string },
): Promise<GeneratedMusic> {
  const palette = PALETTES[Math.floor(Math.random() * PALETTES.length)] as string
  const prompt = musicPrompt(options.seconds + 6, palette)
  const headers = await authHeaders(config)

  log.info(`Composing ${clock(options.seconds + 6)} of music with ${MODEL} (${palette})`)
  const started = Date.now()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: prompt }),
    signal: AbortSignal.timeout(300_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Lyria refused the request: HTTP ${res.status} ${text.slice(0, 400)}`)

  const audio = findAudio(JSON.parse(text))
  if (!audio) throw new Error('Lyria answered without any audio')
  fs.writeFileSync(options.outFile, Buffer.from(audio, 'base64'))
  fs.writeFileSync(`${options.outFile}.prompt.txt`, prompt)
  log.info(`Music composed in ${((Date.now() - started) / 1000).toFixed(0)}s`)
  return { file: options.outFile, palette, prompt }
}
