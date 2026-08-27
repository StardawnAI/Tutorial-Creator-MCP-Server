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
import { boxContains, zoomForBox, MIN_USEFUL_ZOOM, type ZoomEvent } from './zoom.js'
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
  /** Size of the finished video, in CSS pixels - also the browser viewport. */
  width: number
  height: number
  headless: boolean
  /**
   * Pixel density the page is rendered at.
   *
   * This does not affect the recording. `page.screencast` delivers frames at the CSS
   * viewport size whatever the density is set to - measured, not assumed - so raising
   * it buys nothing here and only makes the renderer work harder. It still applies to
   * `page.screenshot()`, which is why the option exists at all.
   */
  deviceScaleFactor: number
  voiceId: string
  modelId: string
  /** Background music file, or null for none. */
  music: string | null
  musicGainDb: number
  showActions: boolean
  quality: number
  /** Ring the target and pulse on click before acting on it. */
  emphasis: boolean
  /** Move the camera in on whatever is being acted on. */
  autoZoom: boolean
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
  readonly zoomEvents: ZoomEvent[] = []

  /** The camera move currently held open, with the region it is showing. */
  private openZoom: {
    event: ZoomEvent
    visible: { x: number; y: number; width: number; height: number }
  } | null = null

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
      // 1:1 with the viewport. Asking for more yields a larger canvas with the same
      // picture parked in the corner, not a sharper one.
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

  /**
   * Point the camera at `box`, or leave it where it is.
   *
   * Pulling out and pushing back in for every click in the same corner of the screen
   * is seasickness, not emphasis. So a move is only made when the new target is not
   * already comfortably on screen, and the existing framing is otherwise kept.
   *
   * Returns the magnification now in effect, or 1 when the camera stayed wide.
   */
  focusOn(
    box: { x: number; y: number; width: number; height: number },
    reason: string,
  ): number {
    if (!this.options.autoZoom) return 1

    const viewport = { width: this.options.width, height: this.options.height }
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

    if (this.openZoom) {
      const held = this.openZoom.visible
      const fitsInFrame =
        boxContains(held, { x: box.x, y: box.y }, -12) &&
        boxContains(held, { x: box.x + box.width, y: box.y + box.height }, -12)
      if (fitsInFrame) return this.openZoom.event.scale
      this.releaseZoom()
    }

    const scale = zoomForBox(box, viewport)
    if (scale < MIN_USEFUL_ZOOM) return 1

    const visibleWidth = viewport.width / scale
    const visibleHeight = viewport.height / scale
    const event: ZoomEvent = {
      atMs: this.videoTimeMs,
      // Left open; stamped when the camera is released or the recording ends.
      releaseMs: this.videoTimeMs,
      centerX: centre.x,
      centerY: centre.y,
      scale,
      reason,
    }
    this.zoomEvents.push(event)
    this.openZoom = {
      event,
      visible: {
        x: Math.max(0, Math.min(viewport.width - visibleWidth, centre.x - visibleWidth / 2)),
        y: Math.max(0, Math.min(viewport.height - visibleHeight, centre.y - visibleHeight / 2)),
        width: visibleWidth,
        height: visibleHeight,
      },
    }
    log.debug(`Camera in to ${scale.toFixed(2)}x on ${reason}`)
    return scale
  }

  /**
   * Pull the camera back out.
   *
   * Anything that moves the ground under the viewer - scrolling, navigating - has to
   * do this first: the recorded centre is a fixed point in the viewport, and once the
   * page slides beneath it the camera would be framing whatever happened to move into
   * that spot.
   */
  releaseZoom(): void {
    if (!this.openZoom) return
    this.openZoom.event.releaseMs = this.videoTimeMs
    this.openZoom = null
  }

  get isZoomed(): boolean {
    return this.openZoom !== null
  }

  /** Stop recording and return the raw video. The browser stays open until closed. */
  async stopRecording(): Promise<{ rawVideo: string | null; videoMs: number }> {
    if (this.finished) throw new Error('This session has already been finished.')
    this.finished = true

    // A move left open would otherwise render as a zoom that never comes back.
    this.releaseZoom()

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
          zoomEvents: this.zoomEvents,
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
