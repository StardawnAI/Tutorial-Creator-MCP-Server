/**
 * The recording session: one at a time.
 *
 * It owns the browsers, the recorders that capture them, and the list of narration
 * cues.
 *
 * Synchronisation: narration is rendered to audio when it is requested and the
 * recording then genuinely waits for its duration, so the video contains exactly
 * the time the voice needs. There is only one clock, and cue offsets come from the
 * recorder's first-frame origin - see docs/ARCHITECTURE.md §3-4.
 *
 * A recording can show more than one browser - a business in one window, its
 * customer in another - and can leave stretches out. Every browser is captured
 * continuously from the moment it opens, and the session notes which one is on air
 * and when. The clock only runs while something is on air, so it carries on
 * seamlessly across every cut, and composition takes exactly those stretches out of
 * the captures.
 *
 * Why not stop and restart the capture at each cut instead: measured, a second
 * `page.screencast` on a page that has been recorded before does not start clean. Its
 * file opened with four seconds of stale frames from before the cut, so no amount of
 * trimming by length put the right picture on the right moment. A capture's first
 * recording, by contrast, starts at its first frame and tracks the wall clock
 * exactly - which is what this relies on.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright-core'
import type { Config } from './env.js'
import { slugify } from './env.js'
import { launchBrowser } from './browser.js'
import type { AvatarCorner } from './compose.js'
import type { ChapterMark } from './motion.js'
import { Privacy, type LocatedTarget, type PrivacySettings, type VeilOptions } from './privacy.js'
import { Recorder } from './recorder.js'
import { hostOf, type LocationMark } from './stage.js'
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
  /** Name of the first browser, for switching back to it later. Defaults to "main". */
  browserName?: string
  /** Start the first browser from an empty throwaway profile instead of `profile`. */
  fresh?: boolean
  /** Page language for every browser in the recording, e.g. "en-US". */
  locale?: string
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
  /** Who speaks the narration: ElevenLabs, or HeyGen's own speech endpoint. */
  voiceSource?: 'elevenlabs' | 'heygen'
  /** Background music file, or null for none. */
  music: string | null
  /** Compose music for this video when it is finished; `music` is the fallback. */
  generateMusic?: boolean
  /** HeyGen look that speaks the narration, shown as a bubble, or null for none. */
  avatarLook?: { id: string; name: string } | null
  /**
   * `always` keeps the bubble on screen for the whole video, with the avatar idling
   * between lines; `speaking` shows it only while a line is being said.
   */
  avatarPresence?: 'always' | 'speaking'
  avatarCorner?: AvatarCorner
  avatarSize?: number
  musicGainDb: number
  showActions: boolean
  quality: number
  /** Ring the target and pulse on click before acting on it. */
  emphasis: boolean
  /** Move the camera in on whatever is being acted on. */
  autoZoom: boolean
  /**
   * Opening, closing and chapter cards rendered with HyperFrames when the video is
   * finished. Decided at the start, because it changes how a chapter is recorded.
   */
  motion?: boolean
  /**
   * Show the recording as a window on the stage. The browser is then the size of the
   * window, and `outputWidth` x `outputHeight` the size of the finished video.
   */
  frame?: boolean
  outputWidth?: number
  outputHeight?: number
  /**
   * Keep private data out of the picture: cookie banners answered, other people's
   * content greyed out, personal data covered. Null switches all of it off.
   */
  privacy?: (PrivacySettings & { hideText: string[] }) | null
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

/** A stretch of one browser's capture that belongs in the video. */
export interface Segment {
  file: string
  /** Where the stretch starts within that file. */
  startMs: number
  durationMs: number
  /** The browser that was on screen. */
  browser: string
}

/** How to open a browser that is not running yet. */
export interface BrowserLaunch {
  profile?: string
  /** An empty throwaway profile - no cookies, no saved logins, like a private window. */
  fresh?: boolean
}

interface OpenBrowser {
  context: BrowserContext
  page: Page
  /** Captures this browser from the moment it opens until the recording ends. */
  recorder: Recorder
  /** The profile it runs on, or null for a throwaway one. */
  profile: string | null
  /** A throwaway profile's directory, deleted when the browser closes. */
  disposableDir: string | null
  /** Its privacy layer, or null when privacy is off. */
  privacy: Privacy | null
}

/** A stretch of wall-clock time during which one browser was on air. */
interface OnAir {
  browser: string
  fromMs: number
  toMs: number
}

export class RecordingSession {
  readonly title: string
  readonly slug: string
  readonly outputDir: string
  readonly options: SessionOptions
  readonly cues: NarrationCue[] = []
  readonly zoomEvents: ZoomEvent[] = []
  /** Chapters to be laid over the video as animated cards, when motion is on. */
  readonly chapters: ChapterMark[] = []
  /** Which site was on screen from when, for the bar above a staged recording. */
  readonly locations: LocationMark[] = []

  /** The camera move currently held open, with the region it is showing. */
  private openZoom: {
    event: ZoomEvent
    visible: { x: number; y: number; width: number; height: number }
  } | null = null

  private readonly config: Config
  private readonly browsers = new Map<string, OpenBrowser>()
  private activeName: string
  private readonly onAir: OnAir[] = []
  /** Wall-clock time the current stretch went on air, or null during a cut. */
  private onAirSince: number | null = null
  /** How many off-camera operations are in progress. */
  private offAirDepth = 0
  /** Set while tutorial_camera has taken the recording off air. */
  private heldOff = false
  /** What the tutorial has asked to keep and to hide, shared by every browser. */
  private veilOptions: VeilOptions = { hideText: [], hideCss: [], keepCss: [] }
  private keepTargets: LocatedTarget[] = []
  private hideTargets: LocatedTarget[] = []
  /** Total length of the stretches already closed. */
  private closedMs = 0
  private stoppedFrames = 0
  private finished = false

  private constructor(config: Config, options: SessionOptions, outputDir: string, slug: string) {
    this.config = config
    this.options = options
    this.title = options.title
    this.slug = slug
    this.outputDir = outputDir
    this.activeName = options.browserName ?? 'main'
    this.veilOptions = { ...this.veilOptions, hideText: options.privacy?.hideText ?? [] }
  }

  /**
   * `url` is loaded before the capture starts, so the video opens on the finished page
   * rather than on a blank one filling in. Measured on the GitHub example: 25 seconds
   * of loading were in the video before the first word.
   */
  static async start(config: Config, options: SessionOptions, url?: string): Promise<RecordingSession> {
    const slug = slugify(options.title)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const outputDir = path.join(config.paths.recordings, `${stamp}_${slug}`)
    fs.mkdirSync(path.join(outputDir, 'audio'), { recursive: true })

    const session = new RecordingSession(config, options, outputDir, slug)
    try {
      const first = await session.openBrowser(session.activeName, {
        profile: options.profile,
        fresh: options.fresh ?? false,
        url,
      })
      // On air from the first frame exactly, so a recording without cuts is its
      // capture from start to finish, as it always was.
      session.onAirSince = first.recorder.firstFrameWallMs
    } catch (err) {
      // A throwaway profile left behind by a failed start would never be cleaned up.
      await session.closeBrowsers()
      throw err
    }

    log.info(`Session "${options.title}" recording to ${outputDir}`)
    return session
  }

  private get active(): OpenBrowser {
    const active = this.browsers.get(this.activeName)
    if (!active) throw new Error('The recording session has no active page.')
    return active
  }

  get page(): Page {
    return this.active.page
  }

  /** Follow the user into popups and new tabs. */
  setActivePage(page: Page): void {
    const active = this.browsers.get(this.activeName)
    if (active) active.page = page
  }

  /** The browser currently on screen. */
  get activeBrowser(): string {
    return this.activeName
  }

  get browserNames(): string[] {
    return [...this.browsers.keys()]
  }

  get videoTimeMs(): number {
    return this.closedMs + (this.onAirSince === null ? 0 : Date.now() - this.onAirSince)
  }

  get isFinished(): boolean {
    return this.finished
  }

  get frameCount(): number {
    let frames = this.stoppedFrames
    for (const open of this.browsers.values()) frames += open.recorder.frames
    return frames
  }

  /**
   * A chapter card. With motion on, only the moment is noted and the animated card is
   * laid over the video when it is finished - drawing the static one into the capture
   * as well would leave it showing through the new one.
   */
  async showChapter(title: string, description: string | undefined, durationMs: number): Promise<void> {
    if (this.options.motion) {
      this.chapters.push({ atMs: this.videoTimeMs, durationMs, title, description })
      return
    }
    await this.active.recorder.showChapter(title, description, durationMs)
  }

  addCue(cue: NarrationCue): void {
    this.cues.push(cue)
  }

  /**
   * Do something without it appearing in the video.
   *
   * The browsers go on being captured, but nothing is on air until `work` has
   * finished, and the clock stands still meanwhile: the viewer sees the moment
   * before and then the moment after.
   */
  async offCamera<T>(work: () => Promise<T>): Promise<T> {
    // A camera move cannot carry across a cut - the picture under it changes.
    this.releaseZoom()
    // Counted, because tool calls can overlap: something done while a cut wait is
    // still pending must not put the recording back on air underneath it.
    if (this.offAirDepth++ === 0) this.goOffAir()
    try {
      return await work()
    } finally {
      if (--this.offAirDepth === 0) this.onAirSince = Date.now()
    }
  }

  /**
   * Take the recording off air until it is put back, across any number of tool calls -
   * for a sign-in nobody needs to watch. The viewer sees the moment before and then
   * the moment after, as with a cut wait. Returns false when nothing changed.
   */
  setLive(live: boolean): boolean {
    if (live === !this.heldOff) return false
    if (!live) {
      this.releaseZoom()
      if (this.offAirDepth++ === 0) this.goOffAir()
      this.heldOff = true
    } else {
      this.heldOff = false
      if (--this.offAirDepth === 0) this.onAirSince = Date.now()
      this.noteLocation(this.page.url())
    }
    return true
  }

  /** False while tutorial_camera has taken the recording off air. */
  get isLive(): boolean {
    return !this.heldOff
  }

  /** The privacy layer of the browser on screen, or null when privacy is off. */
  get privacy(): Privacy | null {
    return this.active.privacy
  }

  /**
   * Change what is kept and hidden, in every browser of the recording - and in any
   * opened later.
   */
  async updatePrivacy(change: {
    keepCss?: string[]
    hideCss?: string[]
    hideText?: string[]
    keep?: LocatedTarget[]
    hide?: LocatedTarget[]
    reset?: boolean
  }): Promise<void> {
    const base = change.reset
      ? { hideText: this.options.privacy?.hideText ?? [], hideCss: [], keepCss: [] }
      : this.veilOptions
    if (change.reset) {
      this.keepTargets = []
      this.hideTargets = []
    }
    const merge = (a: string[], b: string[] = []) => [...new Set([...a, ...b])]
    this.veilOptions = {
      hideText: merge(base.hideText, change.hideText),
      hideCss: merge(base.hideCss, change.hideCss),
      keepCss: merge(base.keepCss, change.keepCss),
    }
    this.keepTargets = [...this.keepTargets, ...(change.keep ?? [])]
    this.hideTargets = [...this.hideTargets, ...(change.hide ?? [])]
    for (const open of this.browsers.values()) {
      await open.privacy?.update(this.veilOptions, this.keepTargets, this.hideTargets)
    }
  }

  /**
   * Cut to another browser, opening it first if this is its first appearance.
   *
   * Launching and loading happen off camera, so the video goes straight from the last
   * moment in one window to the page already open in the other.
   */
  async switchTo(
    name: string,
    options: BrowserLaunch & { url?: string } = {},
  ): Promise<{ opened: boolean }> {
    let opened = false
    await this.offCamera(async () => {
      if (!this.browsers.has(name)) {
        await this.openBrowser(name, options)
        opened = true
      }
      const target = this.browsers.get(name) as OpenBrowser
      if (options.url) {
        await target.page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        // Off camera, so waiting for the page to finish costs the video nothing.
        await target.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
        await target.page.waitForTimeout(800)
        await target.privacy?.settle(target.page, { graceMs: 2000 })
      }
      await target.page.bringToFront().catch(() => {})
      this.activeName = name
      this.noteLocation(target.page.url())
    })
    return { opened }
  }

  /**
   * The site now on screen, noted when it changes. Off camera the clock stands still,
   * so a page loaded during a cut is noted at the moment the video resumes on it.
   */
  private noteLocation(url: string): void {
    const host = hostOf(url)
    if (!host || this.locations.at(-1)?.host === host) return
    this.locations.push({ atMs: this.videoTimeMs, host })
  }

  /** Close the stretch that is on air, if one is. */
  private goOffAir(): void {
    if (this.onAirSince === null) return
    const now = Date.now()
    this.onAir.push({ browser: this.activeName, fromMs: this.onAirSince, toMs: now })
    this.closedMs += now - this.onAirSince
    this.onAirSince = null
  }

  private async openBrowser(name: string, launch: BrowserLaunch & { url?: string }): Promise<OpenBrowser> {
    const fresh = launch.fresh ?? false
    const profile = launch.profile ?? 'default'
    if (!fresh) {
      for (const [other, open] of this.browsers) {
        if (open.profile === profile) {
          throw new Error(
            `Profile "${profile}" is already open in browser "${other}". A profile can only ` +
              'be open in one browser at a time - give this one another profile, or fresh: true.',
          )
        }
      }
    }

    const launched = await launchBrowser(this.config, {
      profile,
      fresh,
      width: this.options.width,
      height: this.options.height,
      headless: this.options.headless,
      deviceScaleFactor: this.options.deviceScaleFactor,
      locale: this.options.locale,
    })

    const recorder = new Recorder(launched.page, {
      path: path.join(this.outputDir, `raw-${String(this.browsers.size).padStart(2, '0')}.webm`),
      // 1:1 with the viewport. Asking for more yields a larger canvas with the same
      // picture parked in the corner, not a sharper one.
      width: this.options.width,
      height: this.options.height,
      quality: this.options.quality,
      showActions: this.options.showActions,
    })
    const open: OpenBrowser = {
      context: launched.context,
      page: launched.page,
      recorder,
      profile: fresh ? null : profile,
      disposableDir: launched.disposableDir,
      privacy: null,
    }
    // Registered before the capture starts, so a failure to start still closes it.
    this.browsers.set(name, open)

    // Before the first page is loaded, so nothing private is painted even once.
    const settings = this.options.privacy
    if (settings) {
      open.privacy = await Privacy.install(launched.context, this.config, settings, this.veilOptions)
      if (this.keepTargets.length || this.hideTargets.length) {
        await open.privacy.update(this.veilOptions, this.keepTargets, this.hideTargets)
      }
    }
    // Only the browser on air moves the bar; one off air is noted when it is cut to.
    //
    // A new page also has to bring the camera back out, however it was reached. Only
    // tutorial_goto and scrolling used to, so pressing Enter on a search box left the
    // camera magnifying the results page at the spot where the box had been.
    // Same-page changes - a dialog that only edits the query string - leave it be.
    let lastPage = pageKey(launched.page.url())
    launched.page.on('framenavigated', frame => {
      if (frame !== launched.page.mainFrame() || name !== this.activeName) return
      this.noteLocation(frame.url())
      const key = pageKey(frame.url())
      if (key !== lastPage) this.releaseZoom()
      lastPage = key
    })
    if (launch.url) {
      await launched.page.goto(launch.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await launched.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
      await launched.page.waitForTimeout(800)
      // A cookie banner is answered before the first frame, not in it.
      await open.privacy?.settle(launched.page, { graceMs: 2000 })
    }
    await recorder.start()

    log.info(`Browser "${name}" open (${fresh ? 'empty throwaway profile' : `profile "${profile}"`})`)
    return open
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

  /** What the camera shows while it is in: the region of the page, and how far in. */
  get cameraFrame(): { x: number; y: number; width: number; height: number; scale: number } | null {
    return this.openZoom ? { ...this.openZoom.visible, scale: this.openZoom.event.scale } : null
  }

  /** Stop recording and return the stretches that make up the video, in order. */
  async stopRecording(): Promise<{ segments: Segment[]; videoMs: number }> {
    if (this.finished) throw new Error('This session has already been finished.')
    this.finished = true

    // A move left open would otherwise render as a zoom that never comes back.
    this.releaseZoom()
    this.goOffAir()

    const captures = new Map<string, { file: string | null; firstFrameMs: number | null }>()
    for (const [name, open] of this.browsers) {
      const firstFrameMs = open.recorder.firstFrameWallMs
      const { file, frames } = await open.recorder.stop()
      this.stoppedFrames += frames
      captures.set(name, { file, firstFrameMs })
    }
    await this.closeBrowsers()

    const segments: Segment[] = []
    for (const stretch of this.onAir) {
      const capture = captures.get(stretch.browser)
      if (!capture?.file || capture.firstFrameMs === null) {
        log.warn(`No capture for browser "${stretch.browser}"; a stretch of the video is missing`)
        continue
      }
      segments.push({
        file: capture.file,
        startMs: Math.max(0, stretch.fromMs - capture.firstFrameMs),
        durationMs: stretch.toMs - stretch.fromMs,
        browser: stretch.browser,
      })
    }
    return { segments, videoMs: this.closedMs }
  }

  private async closeBrowsers(): Promise<void> {
    for (const [name, open] of this.browsers) {
      await open.context.close().catch(err => log.warn(`Error closing browser "${name}"`, err))
      // A throwaway profile holds whatever was signed into during the recording, so
      // it must not outlive it.
      if (open.disposableDir) {
        try {
          fs.rmSync(open.disposableDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        } catch (err) {
          log.warn(`Could not delete the throwaway profile at ${open.disposableDir}`, err)
        }
      }
    }
    this.browsers.clear()
  }

  /** Abort without producing anything. */
  async cancel(): Promise<void> {
    this.finished = true
    for (const open of this.browsers.values()) {
      if (open.recorder.isRunning) {
        await open.recorder.stop().catch(err => log.warn('Error stopping recorder', err))
      }
    }
    await this.closeBrowsers()
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
  writeTimeline(segments: Segment[] = []): string {
    const file = path.join(this.outputDir, 'timeline.json')
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          title: this.title,
          slug: this.slug,
          recordedAt: new Date().toISOString(),
          // The words to hide are exactly what must not be kept lying around.
          options: {
            ...this.options,
            privacy: this.options.privacy ? { ...this.options.privacy, hideText: [] } : null,
          },
          segments,
          cues: this.cues,
          zoomEvents: this.zoomEvents,
          chapters: this.chapters,
          locations: this.locations,
        },
        null,
        2,
      ),
    )
    return file
  }
}

/** A page as far as the camera is concerned: its address without query or fragment. */
function pageKey(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
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
