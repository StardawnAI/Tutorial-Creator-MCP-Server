/**
 * The stage: the recording shown as a window on the Stardawn ground, the way produced
 * screen tutorials present an app, rather than as a capture that fills the frame.
 *
 * The window is a fixed fraction of the video, and the browser records at exactly the
 * window's size, so the app is shown pixel for pixel - nothing is scaled down to make
 * room for the frame. Around it: rounded corners, a soft shadow, and a slim bar that
 * names the site on screen.
 *
 * The stage never moves, so it is not rendered as video. `assets/motion/stage.html`
 * is photographed twice with the Chromium the recorder already uses - once whole, as
 * the ground under the recording, and once cut down to what lies over it: the bar and
 * the corners. The composition lays the recording between the two. One top layer is
 * made per site, and the composition switches between them as the page moves on.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import type { StageComposition } from './compose.js'
import type { Config } from './env.js'
import { fillTemplate } from './motion.js'
import { log } from './logger.js'

export interface StageLayout {
  /** The finished video. */
  width: number
  height: number
  /** The whole window, bar included. */
  window: { x: number; y: number; width: number; height: number }
  /** The part the recording fills: the window below its bar. Also the capture size. */
  content: { x: number; y: number; width: number; height: number }
  bar: number
  radius: number
  /** 1 at 1080p; sizes in the stage scale with the video. */
  scale: number
}

const even = (n: number) => Math.round(n / 2) * 2

/**
 * Where the window sits in a video of this size.
 *
 * The content is five sixths of the frame each way - 1600x900 in a 1920x1080 video -
 * which leaves a margin wide enough to read as a ground, and keeps the app at a size
 * where its text is still comfortable to read.
 */
export function stageLayout(width: number, height: number): StageLayout {
  const scale = height / 1080
  const bar = even(44 * scale)
  const contentWidth = even((width * 5) / 6)
  const contentHeight = even((height * 5) / 6)
  const windowHeight = contentHeight + bar
  const x = even((width - contentWidth) / 2)
  const y = even((height - windowHeight) / 2)
  return {
    width,
    height,
    window: { x, y, width: contentWidth, height: windowHeight },
    content: { x, y: y + bar, width: contentWidth, height: contentHeight },
    bar,
    radius: Math.round(14 * scale),
    scale,
  }
}

/**
 * What the bar shows for a page: its host, and nothing after it.
 *
 * Deliberately not the full address. A path or a query can carry a sign-in code or a
 * token - an OAuth redirect does exactly that - and the bar is on screen the whole time.
 */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.host.replace(/^www\./, '')
  } catch {
    return null
  }
}

export interface RenderedStage {
  layout: StageLayout
  base: string
  /** The top layer for each host; the key '' is the bar with no address in it. */
  tops: Map<string, string>
}

/** Photograph the stage: one ground, and one top layer per host. Cached by content. */
export async function renderStage(
  config: Config,
  options: { width: number; height: number; hosts: string[] },
): Promise<RenderedStage> {
  const layout = stageLayout(options.width, options.height)
  const templates = path.join(config.paths.assets, 'motion')
  const template = fs.readFileSync(path.join(templates, 'stage.html'), 'utf8')
  const brand = fs.readFileSync(path.join(templates, 'brand.css'))
  fs.mkdirSync(config.paths.motionCache, { recursive: true })

  const values = {
    width: layout.width,
    height: layout.height,
    x: layout.window.x,
    y: layout.window.y,
    w: layout.window.width,
    h: layout.window.height,
    bar: layout.bar,
    radius: layout.radius,
    scale: layout.scale,
  }
  const shots = [
    { layer: 'base', host: '' },
    ...[...new Set(['', ...options.hosts])].map(host => ({ layer: 'top', host })),
  ].map(shot => {
    const html = fillTemplate(template, { ...values, ...shot })
    const key = crypto.createHash('sha256').update(html).update(brand).digest('hex').slice(0, 24)
    return { ...shot, html, file: path.join(config.paths.motionCache, `stage-${shot.layer}-${key}.png`) }
  })

  const missing = shots.filter(shot => !fs.existsSync(shot.file))
  if (missing.length > 0) {
    const started = Date.now()
    const work = path.join(config.paths.motionCache, `stage-work-${process.pid}`)
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, 'brand.css'), brand)
    const browser = await chromium.launch({
      headless: true,
      ...(config.chromiumPath ? { executablePath: config.chromiumPath } : {}),
    })
    try {
      const page = await browser.newPage({ viewport: { width: layout.width, height: layout.height } })
      for (const shot of missing) {
        const file = path.join(work, 'stage.html')
        fs.writeFileSync(file, shot.html, 'utf8')
        await page.goto(pathToFileURL(file).href, { waitUntil: 'load' })
        // Satoshi comes from Fontshare; without a network it falls back quietly.
        await page.evaluate(() => document.fonts.ready).catch(() => {})
        await page.screenshot({ path: shot.file, type: 'png', omitBackground: shot.layer === 'top' })
      }
    } finally {
      await browser.close()
      fs.rmSync(work, { recursive: true, force: true })
    }
    log.info(`Stage drawn: ${missing.length} layer(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  }

  return {
    layout,
    base: shots[0]?.file as string,
    tops: new Map(shots.filter(s => s.layer === 'top').map(s => [s.host, s.file])),
  }
}

/** The site on screen from a moment on, on the recording's clock. */
export interface LocationMark {
  atMs: number
  host: string
}

/**
 * The stage for a recording: drawn, and with the bar switched at every moment the
 * site on screen changed. Before the first mark the bar shows the first site.
 */
export async function stageComposition(
  config: Config,
  options: { width: number; height: number; locations: LocationMark[] },
): Promise<StageComposition> {
  const hosts = options.locations.map(l => l.host)
  const stage = await renderStage(config, { width: options.width, height: options.height, hosts })
  const marks = options.locations.length > 0 ? options.locations : [{ atMs: 0, host: '' }]
  return {
    base: stage.base,
    tops: marks.map((mark, i) => ({
      file: stage.tops.get(mark.host) as string,
      fromMs: i === 0 ? 0 : mark.atMs,
      // The last one runs to the end, however long the recording is.
      toMs: marks[i + 1]?.atMs ?? 1e9,
    })),
    content: stage.layout.content,
  }
}
