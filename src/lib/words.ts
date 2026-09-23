/**
 * When each word of a narration line is spoken, for captions that light up word by
 * word as the voice reaches them.
 *
 * The timings are taken from the audio itself, after the fact, by ElevenLabs' forced
 * alignment: given a clip and the text it says, it returns where every word starts
 * and ends. That one route covers every case there is - a line ElevenLabs spoke, a
 * line HeyGen spoke, and a recording made months before this existed - because it
 * only needs the file and the sentence, both of which every recording keeps.
 *
 * Without a key, or when the alignment does not match the text word for word, the
 * timings are estimated from the length of each word. That is close enough to read
 * naturally and never worse than captions that do not move at all.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './env.js'
import { log } from './logger.js'

const ALIGN_URL = 'https://api.elevenlabs.io/v1/forced-alignment'

/** One word and its moment, relative to the start of the clip. */
export interface WordTiming {
  text: string
  startMs: number
  endMs: number
}

export interface LineTimings {
  words: WordTiming[]
  source: 'aligned' | 'estimated'
}

/** The words of a line as they appear on screen - the unit a caption highlights. */
export function tokens(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

/**
 * Spread a line's duration over its words by their length.
 *
 * Longer words take longer to say, and a word always costs a little on its own, so
 * each gets its character count plus one. The first few percent are left as the
 * breath before the first word - measured on the real clips, speech starts 80 to
 * 120 ms in.
 */
export function estimateTimings(text: string, durationMs: number): WordTiming[] {
  const words = tokens(text)
  if (words.length === 0 || durationMs <= 0) return []
  const lead = Math.min(120, durationMs * 0.04)
  const tail = Math.min(200, durationMs * 0.06)
  const span = Math.max(1, durationMs - lead - tail)
  const weights = words.map(w => w.length + 1)
  const total = weights.reduce((sum, w) => sum + w, 0)

  let at = lead
  return words.map((word, i) => {
    const length = (span * (weights[i] as number)) / total
    const timing = { text: word, startMs: Math.round(at), endMs: Math.round(at + length) }
    at += length
    return timing
  })
}

/** Ask ElevenLabs where each word in the clip is. Null when it cannot be matched. */
async function align(config: Config, audioFile: string, text: string): Promise<WordTiming[] | null> {
  if (!config.elevenLabsApiKey) return null

  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(audioFile)], { type: 'audio/mpeg' }), path.basename(audioFile))
  form.append('text', text)

  let response: Response | null = null
  for (let attempt = 1; attempt <= 3 && !response; attempt++) {
    try {
      response = await fetch(ALIGN_URL, {
        method: 'POST',
        headers: { 'xi-api-key': config.elevenLabsApiKey },
        body: form,
        signal: AbortSignal.timeout(90_000),
      })
    } catch (err) {
      log.warn(`Word alignment request failed (attempt ${attempt}/3): ${(err as Error).message}`)
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 2500 * attempt))
    }
  }
  if (!response) return null
  if (!response.ok) {
    log.warn(`Word alignment refused (HTTP ${response.status}); estimating instead`)
    return null
  }

  const body = (await response.json()) as {
    words?: Array<{ text: string; start: number; end: number }>
  }
  // The answer interleaves the gaps between words as entries of their own.
  const words = (body.words ?? []).filter(w => w.text.trim().length > 0)
  const expected = tokens(text)
  if (words.length !== expected.length) {
    log.warn(
      `Word alignment returned ${words.length} words for ${expected.length}; estimating instead`,
    )
    return null
  }
  return words.map((w, i) => ({
    // Our own spelling, so the caption shows exactly the line that was written.
    text: expected[i] as string,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }))
}

/**
 * Word timings for one narration clip.
 *
 * Kept under a hash of the audio and the text, so a recording re-rendered - or the
 * same sentence in another recording - is never aligned twice.
 */
export async function wordTimings(
  config: Config,
  line: { audioFile: string; text: string; durationMs: number },
): Promise<LineTimings> {
  const key = crypto
    .createHash('sha256')
    .update(fs.readFileSync(line.audioFile))
    .update(line.text.trim())
    .digest('hex')
    .slice(0, 32)
  fs.mkdirSync(config.paths.ttsCache, { recursive: true })
  const cacheFile = path.join(config.paths.ttsCache, `${key}.words.json`)

  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as LineTimings
    } catch {
      // A damaged cache entry is simply redone.
    }
  }

  const aligned = await align(config, line.audioFile, line.text)
  const result: LineTimings = aligned
    ? { words: aligned, source: 'aligned' }
    : { words: estimateTimings(line.text, line.durationMs), source: 'estimated' }

  // Only a real alignment is worth keeping; an estimate is free to make again, and a
  // key added later should get the chance to replace it.
  if (result.source === 'aligned') fs.writeFileSync(cacheFile, JSON.stringify(result))
  return result
}
