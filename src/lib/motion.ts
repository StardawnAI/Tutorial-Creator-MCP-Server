/**
 * Motion cards - the opening, the closing and the chapter cards - rendered with
 * HyperFrames, HeyGen's open-source HTML-to-video renderer (Apache-2.0).
 *
 * Each card is an HTML template in `assets/motion` animated with GSAP. HyperFrames
 * loads it in headless Chrome, asks it for every frame in turn, and encodes the
 * frames with ffmpeg, so the result is exact to the frame and identical on every
 * run. The composition then lays the cards into the video; the recording itself
 * never passes through HyperFrames.
 *
 * That split was measured, not guessed. A 4.5 s card renders in about 20 s, which a
 * cache makes a one-off. Pushing a whole 68 s recording through HyperFrames took
 * 116 s and bought nothing the ffmpeg composition does not already do exactly.
 *
 * It is optional. Without the package - or on a Node older than it accepts - a
 * recording is composed as it always was, only without the cards.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Config } from './env.js'
import { requireFfprobe } from './env.js'
import { probeDuration, run } from './ffmpeg.js'
import { log } from './logger.js'

export type MotionTemplate = 'opening' | 'closing' | 'chapter'

/** Frame rate of the finished video, which the cards are rendered at. */
const FPS = 25

/** HyperFrames 0.8 refuses to start on anything older. */
const MIN_NODE_MAJOR = 22

const require = createRequire(import.meta.url)

interface HyperFrames {
  cli: string
  version: string
  gsap: string
}

let found: HyperFrames | null | undefined

/** The HyperFrames command line and the GSAP build the templates load, or null. */
export function findHyperFrames(): HyperFrames | null {
  if (found !== undefined) return found
  found = null
  try {
    const manifest = require.resolve('hyperframes/package.json')
    const { version, bin } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
      version: string
      bin: Record<string, string>
    }
    const cli = path.join(path.dirname(manifest), bin.hyperframes ?? 'bin/hyperframes.mjs')
    const gsap = require.resolve('gsap/dist/gsap.min.js')
    if (fs.existsSync(cli) && fs.existsSync(gsap)) found = { cli, version, gsap }
  } catch {
    // Not installed: the optional dependency was skipped or removed.
  }
  return found
}

/** Whether cards can be rendered here, and if not, why not - in words for the user. */
export function motionAvailability(): { ok: true; version: string } | { ok: false; reason: string } {
  const major = Number(process.versions.node.split('.')[0])
  if (major < MIN_NODE_MAJOR) {
    return { ok: false, reason: `HyperFrames needs Node ${MIN_NODE_MAJOR} or newer; this is ${process.versions.node}.` }
  }
  const hyperframes = findHyperFrames()
  if (!hyperframes) {
    return { ok: false, reason: 'HyperFrames is not installed (npm install hyperframes gsap).' }
  }
  return { ok: true, version: hyperframes.version }
}

/** The text a template shows, made safe to place between HTML tags. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Put the values into a template's `{{name}}` slots.
 *
 * A slot without a value is left empty, which the templates hide - so an optional
 * line such as a subtitle simply is not there, rather than reading "{{subtitle}}".
 */
export function fillTemplate(html: string, values: Record<string, string | number>): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = values[name]
    return value === undefined ? '' : escapeHtml(String(value).trim())
  })
}

/** Files every template loads besides itself. */
const TEMPLATE_ASSETS = ['brand.css', 'stardawn-logo.png']

export interface MotionRequest {
  template: MotionTemplate
  /** Text for the template's slots: title, subtitle, and so on. */
  values: Record<string, string>
  durationSec: number
  outFile: string
  /**
   * Render with a transparent background, for a card that is laid over the picture
   * rather than cut in. See `transparentFormat` for which file that makes.
   */
  transparent?: boolean
}

/**
 * The container for a transparent card: VP9 with alpha in a .webm wherever this
 * ffmpeg can decode it, otherwise ProRes 4444 in a .mov.
 *
 * Measured on the chapter card - a veil over the whole frame, three seconds long: the
 * ProRes file was 68 MB and the WebM 0.25 MB, and laid over the same picture the two
 * agree to 47 dB, which is invisible. The WebM costs about ten more seconds to encode.
 *
 * The alpha of a VP9 file survives only through libvpx: ffmpeg's own VP9 decoder
 * drops it, and the veil would come out as a solid block. So the composition names
 * libvpx for these inputs, and a build without it gets ProRes instead.
 */
let transparentFormat: Promise<'webm' | 'mov'> | null = null
export function transparentCardFormat(config: Config): Promise<'webm' | 'mov'> {
  transparentFormat ??= config.ffmpegPath
    ? run(config.ffmpegPath, ['-hide_banner', '-decoders'], 60_000)
        .then(({ stdout }) => (/\blibvpx-vp9\b/.test(stdout) ? ('webm' as const) : ('mov' as const)))
        .catch(() => 'mov' as const)
    : Promise.resolve('mov' as const)
  return transparentFormat
}

/**
 * Render one card. Returns `outFile`.
 *
 * Cached by everything that shapes the frames - the filled-in template, the shared
 * styles and logo, the HyperFrames version - so a recording rendered again, or a
 * second tutorial with the same closing card, costs nothing.
 */
export async function renderMotion(config: Config, request: MotionRequest): Promise<string> {
  const availability = motionAvailability()
  if (!availability.ok) throw new Error(availability.reason)
  const hyperframes = findHyperFrames() as HyperFrames

  const templates = path.join(config.paths.assets, 'motion')
  const templateFile = path.join(templates, `${request.template}.html`)
  if (!fs.existsSync(templateFile)) throw new Error(`No motion template at ${templateFile}`)

  const durationSec = Math.round(request.durationSec * FPS) / FPS
  const html = fillTemplate(fs.readFileSync(templateFile, 'utf8'), {
    ...request.values,
    duration: durationSec.toFixed(2),
  })

  const format = request.transparent ? await transparentCardFormat(config) : 'mp4'
  const hash = crypto.createHash('sha256').update(html)
  for (const asset of TEMPLATE_ASSETS) hash.update(fs.readFileSync(path.join(templates, asset)))
  hash.update([hyperframes.version, format, FPS].join('|'))
  const key = hash.digest('hex').slice(0, 32)

  fs.mkdirSync(config.paths.motionCache, { recursive: true })
  const cached = path.join(config.paths.motionCache, `${request.template}-${key}.${format}`)

  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
    log.info(`Motion card "${request.template}": already rendered`)
  } else {
    // A small project of its own: the page, what it loads, nothing else.
    const project = path.join(config.paths.motionCache, `work-${key}`)
    fs.rmSync(project, { recursive: true, force: true })
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'index.html'), html, 'utf8')
    for (const asset of TEMPLATE_ASSETS) {
      fs.copyFileSync(path.join(templates, asset), path.join(project, asset))
    }
    // Loaded from node_modules rather than a CDN, so a render needs no network for
    // the animation itself. The typeface still comes from Fontshare, and falls back
    // to Segoe UI without it.
    fs.copyFileSync(hyperframes.gsap, path.join(project, 'gsap.min.js'))

    const started = Date.now()
    const partial = `${cached}.partial.${format}`
    try {
      await run(
        process.execPath,
        [
          hyperframes.cli, 'render', project,
          '--output', partial,
          '--fps', String(FPS),
          '--format', format,
          '--quality', 'delivery',
          // The fastest VP9 setting; the card is re-encoded into the video anyway.
          ...(format === 'webm' ? ['--vp9-cpu-used', '8'] : []),
          '--quiet',
        ],
        5 * 60_000,
        project,
        {
          // Anonymous usage statistics go to HeyGen by default; not from here.
          HYPERFRAMES_NO_TELEMETRY: '1',
          DO_NOT_TRACK: '1',
          HYPERFRAMES_NO_UPDATE_CHECK: '1',
          HYPERFRAMES_SKIP_SKILLS: '1',
          // The ffmpeg the rest of the pipeline is verified against, not whatever
          // PATH offers - on this machine that is a 9.x build known to crash.
          ...(config.ffmpegPath ? { HYPERFRAMES_FFMPEG_PATH: config.ffmpegPath } : {}),
          ...(config.ffprobePath ? { HYPERFRAMES_FFPROBE_PATH: config.ffprobePath } : {}),
        },
      )
      if (!fs.existsSync(partial)) throw new Error('HyperFrames finished without writing a file.')
      fs.renameSync(partial, cached)
    } finally {
      fs.rmSync(partial, { force: true })
      fs.rmSync(project, { recursive: true, force: true })
    }
    log.info(`Motion card "${request.template}" rendered in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  }

  const rendered = await probeDuration(requireFfprobe(config), cached)
  if (rendered === null || Math.abs(rendered - durationSec) > 0.1) {
    fs.rmSync(cached, { force: true })
    throw new Error(
      `The "${request.template}" card came out ${rendered?.toFixed(2) ?? 'unreadable'}s long, ` +
        `not ${durationSec.toFixed(2)}s.`,
    )
  }

  // The caller names the file; the container is decided here.
  const outFile = request.outFile.replace(/\.[^.\\/]+$/, '') + `.${format}`
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.copyFileSync(cached, outFile)
  return outFile
}

/** A chapter as the recording noted it: what to show, and when on its clock. */
export interface ChapterMark {
  atMs: number
  durationMs: number
  title: string
  description?: string
}

/** Length of the opening and the closing card. */
export const CARD_SECONDS = 4.5

export interface CardPlan {
  title: string
  /** Seconds of recording between the cards, for the running time on the opening. */
  recordingSec: number
  chapters: ChapterMark[]
  outDir: string
  /** Null for no opening. `subtitle` replaces the running time under the title. */
  opening: { subtitle?: string } | null
  /** Null for no closing. */
  closing: { title?: string; text?: string } | null
}

export interface RenderedCards {
  opening: string | null
  closing: string | null
  overlays: Array<{ file: string; atMs: number; durationMs: number }>
  /** One line per card that could not be rendered; the video goes out without it. */
  failures: string[]
}

/**
 * Every card a recording asks for. A card that fails is reported and left out - the
 * video is still delivered, as it is for an avatar line that fails.
 */
export async function renderCards(config: Config, plan: CardPlan): Promise<RenderedCards> {
  const result: RenderedCards = { opening: null, closing: null, overlays: [], failures: [] }
  const attempt = async <T>(what: string, work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work()
    } catch (err) {
      const reason = `${what}: ${(err as Error).message.split('\n')[0]}`
      log.warn(`Motion card left out - ${reason}`)
      result.failures.push(reason)
      return null
    }
  }

  if (plan.opening) {
    // The whole video, cards included, to the nearest minute - what a viewer wants to
    // know before they commit to watching. Rounded, not up: 77 seconds is "about 1".
    const minutes = Math.max(1, Math.round((plan.recordingSec + 2 * CARD_SECONDS) / 60))
    result.opening = await attempt('opening', () =>
      renderMotion(config, {
        template: 'opening',
        durationSec: CARD_SECONDS,
        values: {
          eyebrow: 'Tutorial',
          title: plan.title,
          subtitle: plan.opening?.subtitle ?? `About ${minutes} minute${minutes === 1 ? '' : 's'}`,
        },
        outFile: path.join(plan.outDir, 'opening.mp4'),
      }),
    )
  }

  for (const [i, chapter] of plan.chapters.entries()) {
    const counter =
      plan.chapters.length > 1
        ? `${String(i + 1).padStart(2, '0')} / ${String(plan.chapters.length).padStart(2, '0')}`
        : ''
    const file = await attempt(`chapter "${chapter.title}"`, () =>
      renderMotion(config, {
        template: 'chapter',
        durationSec: chapter.durationMs / 1000,
        transparent: true,
        values: { counter, title: chapter.title, description: chapter.description ?? '' },
        outFile: path.join(plan.outDir, `chapter-${String(i + 1).padStart(2, '0')}`),
      }),
    )
    if (file) result.overlays.push({ file, atMs: chapter.atMs, durationMs: chapter.durationMs })
  }

  if (plan.closing) {
    result.closing = await attempt('closing', () =>
      renderMotion(config, {
        template: 'closing',
        durationSec: CARD_SECONDS,
        values: {
          eyebrow: 'Done',
          title: plan.closing?.title ?? "That's all it takes",
          subtitle: plan.closing?.text ?? '',
        },
        outFile: path.join(plan.outDir, 'closing.mp4'),
      }),
    )
  }

  return result
}
