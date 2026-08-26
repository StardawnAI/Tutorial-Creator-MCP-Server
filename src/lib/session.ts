/**
 * The recording session: one at a time.
 *
 * It owns the browser, the recorder that defines the timeline, and the list of
 * narration cues.
 *
 * Synchronisation: narration is rendered to audio when it is requested and the
 * recording then genuinely waits for its duration, so the video contains exactly
 * the time the voice needs. There is only one clock, and cue offsets come from the
 * recorder's first-frame origin - see docs/ARCHITECTURE.md §3-4.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright-core'
import type { Config } from './env.js'
import { slugify } from './env.js'
import { launchBrowser } from './browser.js'
import { Recorder } from './recorder.js'
import { log } from './logger.js'

export interface NarrationCue {
  /** Milliseconds from the first recorded frame. */
  atMs: number
  text: string
  /** Rendered audio file, or null when narration could not be synthesised. */
  audioFile: string | null
  durationMs: number
  voiceId: string
}

export interface SessionOptions {
  title: string
  profile: string
  width: number
  height: number
  headless: boolean
  deviceScaleFactor: number
  voiceId: string
  modelId: string
  /** Background music file, or null for none. */
  music: string | null
  musicGainDb: number
  showActions: boolean
  quality: number
}

export interface SessionSummary {
  title: string
  slug: string
  outputDir: string
  cueCount: number
  videoMs: number
  narratedMs: number
  frames: number
}

export class RecordingSession {
  readonly title: string
  readonly slug: string
  readonly outputDir: string
  readonly options: SessionOptions
  readonly cues: NarrationCue[] = []

  private context: BrowserContext | null = null
  private activePage: Page | null = null
  private recorder: Recorder | null = null
  private finished = false

  private constructor(options: SessionOptions, outputDir: string, slug: string) {
    this.options = options
    this.title = options.title
    this.slug = slug
    this.outputDir = outputDir
  }

  static async start(config: Config, options: SessionOptions): Promise<RecordingSession> {
    const slug = slugify(options.title)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const outputDir = path.join(config.paths.recordings, `${stamp}_${slug}`)
    fs.mkdirSync(path.join(outputDir, 'audio'), { recursive: true })

    const session = new RecordingSession(options, outputDir, slug)

    const launched = await launchBrowser(config, {
      profile: options.profile,
      width: options.width,
      height: options.height,
      headless: options.headless,
      deviceScaleFactor: options.deviceScaleFactor,
    })
    session.context = launched.context
    session.activePage = launched.page

    const recorder = new Recorder(launched.page, {
      path: path.join(outputDir, 'raw.webm'),
      width: options.width,
      height: options.height,
      quality: options.quality,
      showActions: options.showActions,
    })
    await recorder.start()
    session.recorder = recorder

    log.info(`Session "${options.title}" recording to ${outputDir}`)
    return session
  }

  get page(): Page {
    if (!this.activePage) throw new Error('The recording session has no active page.')
    return this.activePage
  }

  /** Follow the user into popups and new tabs. */
  setActivePage(page: Page): void {
    this.activePage = page
  }

  get videoTimeMs(): number {
    return this.recorder?.videoTimeMs() ?? 0
  }

  get isFinished(): boolean {
    return this.finished
  }

  get frameCount(): number {
    return this.recorder?.frames ?? 0
  }

  async showChapter(title: string, description?: string, durationMs?: number): Promise<void> {
    if (!this.recorder) throw new Error('No recorder is running.')
    await this.recorder.showChapter(title, description, durationMs)
  }

  addCue(cue: NarrationCue): void {
    this.cues.push(cue)
  }

  /** Stop recording and return the raw video. The browser stays open until closed. */
  async stopRecording(): Promise<{ rawVideo: string | null; videoMs: number }> {
    if (this.finished) throw new Error('This session has already been finished.')
    this.finished = true

    if (!this.recorder) return { rawVideo: null, videoMs: 0 }
    const result = await this.recorder.stop()
    await this.closeBrowser()
    return { rawVideo: result.file, videoMs: result.durationMs }
  }

  private async closeBrowser(): Promise<void> {
    if (!this.context) return
    await this.context.close().catch(err => log.warn('Error closing browser context', err))
    this.context = null
    this.activePage = null
  }

  /** Abort without producing anything. */
  async cancel(): Promise<void> {
    this.finished = true
    if (this.recorder?.isRunning) {
      await this.recorder.stop().catch(err => log.warn('Error stopping recorder', err))
    }
    await this.closeBrowser()
  }

  summary(): SessionSummary {
    return {
      title: this.title,
      slug: this.slug,
      outputDir: this.outputDir,
      cueCount: this.cues.length,
      videoMs: this.videoTimeMs,
      narratedMs: this.cues.reduce((sum, c) => sum + c.durationMs, 0),
      frames: this.frameCount,
    }
  }

  /** Persist the timeline so a finished recording can be re-composed later. */
  writeTimeline(): string {
    const file = path.join(this.outputDir, 'timeline.json')
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          title: this.title,
          slug: this.slug,
          recordedAt: new Date().toISOString(),
          options: this.options,
          cues: this.cues,
        },
        null,
        2,
      ),
    )
    return file
  }
}

/** Module-level holder: exactly one recording may be in flight. */
let current: RecordingSession | null = null

export function getSession(): RecordingSession | null {
  return current
}

export function requireSession(): RecordingSession {
  if (!current || current.isFinished) {
    throw new Error('No recording is running. Call tutorial_start first.')
  }
  return current
}

export function setSession(session: RecordingSession | null): void {
  current = session
}
