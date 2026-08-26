/**
 * Screen recording via `page.screencast`.
 *
 * The critical detail is the time origin. Measured on this machine: the video's
 * clock starts at the moment the first frame is delivered, and from then on tracks
 * wall-clock time exactly - a colour flipped at 1006/2017/3021/4031/5037 ms of wall
 * clock appeared at 0.840/1.880/2.880/3.880/4.880 s of video, a constant 150 ms
 * offset equal to the first frame's arrival, with intervals preserved to the
 * millisecond.
 *
 * So `onFrame` captures that origin, and every cue offset is simply
 * `wallClockNow - firstFrameAt`. That subtraction is the whole synchronisation
 * mechanism. See docs/ARCHITECTURE.md §3.
 */

import fs from 'node:fs'
import type { Page } from 'playwright-core'
import { log } from './logger.js'

export interface RecorderOptions {
  /** Destination file. Playwright requires a `.webm` extension. */
  path: string
  width: number
  height: number
  /** JPEG quality of the captured frames, 0-100. */
  quality?: number
  /** Draw the animated pointer and per-action captions. */
  showActions?: boolean
}

export class Recorder {
  private readonly page: Page
  private readonly options: RecorderOptions

  private firstFrameAt: number | null = null
  private lastFrameAt: number | null = null
  private frameCount = 0
  private running = false

  constructor(page: Page, options: RecorderOptions) {
    this.page = page
    this.options = options
  }

  async start(): Promise<void> {
    if (this.running) throw new Error('The recorder is already running.')
    if (!this.options.path.endsWith('.webm')) {
      throw new Error('Playwright records to .webm only.')
    }

    await this.page.screencast.start({
      path: this.options.path,
      size: { width: this.options.width, height: this.options.height },
      quality: this.options.quality ?? 90,
      onFrame: () => {
        const now = Date.now()
        if (this.firstFrameAt === null) {
          this.firstFrameAt = now
          log.debug('First screencast frame delivered - video clock starts here')
        }
        this.lastFrameAt = now
        this.frameCount++
      },
    })
    this.running = true

    if (this.options.showActions !== false) {
      // The animated pointer plus a caption naming each action. Without a visible
      // pointer a click-through tutorial cannot be followed.
      await this.page.screencast.showActions({ cursor: 'pointer', duration: 800 })
    }

    await this.waitForFirstFrame()
  }

  /**
   * Block until the video clock actually exists. Until the first frame lands there
   * is no origin to measure cue offsets against.
   */
  private async waitForFirstFrame(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.firstFrameAt === null && Date.now() < deadline) {
      await this.page.waitForTimeout(20)
    }
    if (this.firstFrameAt === null) {
      throw new Error(
        'The screencast delivered no frames within 5s. The page may not be painting.',
      )
    }
  }

  /** Position in the recorded video, in milliseconds, for right now. */
  videoTimeMs(): number {
    if (this.firstFrameAt === null) return 0
    return Date.now() - this.firstFrameAt
  }

  /** Nothing painted for this long - a sign the page is frozen or throttled. */
  msSinceLastFrame(): number | null {
    return this.lastFrameAt === null ? null : Date.now() - this.lastFrameAt
  }

  get frames(): number {
    return this.frameCount
  }

  get isRunning(): boolean {
    return this.running
  }

  async showChapter(title: string, description?: string, durationMs = 2200): Promise<void> {
    await this.page.screencast.showChapter(title, { description, duration: durationMs })
  }

  /** Stop and return the finished file, or null if nothing usable was written. */
  async stop(): Promise<{ file: string | null; durationMs: number; frames: number }> {
    if (!this.running) return { file: null, durationMs: 0, frames: this.frameCount }
    this.running = false

    const durationMs = this.videoTimeMs()
    await this.page.screencast.stop()

    const file = fs.existsSync(this.options.path) ? this.options.path : null
    if (!file) log.warn(`Screencast produced no file at ${this.options.path}`)

    log.info(`Recording stopped: ${this.frameCount} frames over ${durationMs}ms`)
    return { file, durationMs, frames: this.frameCount }
  }
}
