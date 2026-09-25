/**
 * Keeping private data out of the picture.
 *
 * A tutorial is recorded in a real, signed-in browser, so the screen is full of things
 * that are nobody's business: other people's messages and posts, the names in a chat
 * list, an email address in a header, the account chooser Google pops over a page -
 * and a cookie banner in front of all of it. None of that teaches anything.
 *
 * Three things happen here, all of them inside the page and before a frame is
 * painted, so the private data never reaches the capture file at all - not only the
 * finished video:
 *
 * - Cookie banners are answered with "reject" by DuckDuckGo's autoconsent, which knows
 *   the consent tools of some three hundred vendors, Facebook's, Instagram's and
 *   Google's own among them. It hides a banner it recognises while it works.
 * - Elements the platform schema (`assets/privacy/platforms.json`) calls somebody's
 *   content are greyed out: blurred, drained of colour and dimmed. Pure CSS generated
 *   from the schema, so it applies on first paint and survives an app re-rendering
 *   the element. What the tutorial is about is exempt - see `keepAuto` - and stays
 *   sharp.
 * - Personal data on any site, schema or not: email addresses, phone numbers, IBANs,
 *   card numbers and API keys in text are covered with a grey bar (the CSS Custom
 *   Highlight API, which paints over a range of text without touching the page's DOM),
 *   and personal form fields show dots instead of what is typed into them.
 *
 * Sign-in clutter is handled by the same schema: the one-tap account chooser is
 * hidden, and a few known "Save your login info?" prompts are answered "Not now".
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { z } from 'zod'
import type { BrowserContext, Frame, Locator, Page } from 'playwright-core'
import type { Config } from './env.js'
import { log } from './logger.js'

export interface PrivacySettings {
  /** Answer cookie banners with "reject". */
  cookies: boolean
  /** Grey out private content and cover personal data. */
  veil: boolean
}

/** What the tutorial has said about this recording in particular. */
export interface VeilOptions {
  /** Words covered wherever they appear - a customer's name, an account handle. */
  hideText: string[]
  /** CSS selectors greyed out whatever the schema says. Applied on first paint. */
  hideCss: string[]
  /** CSS selectors kept visible whatever the schema says. */
  keepCss: string[]
}

/** An element described in Playwright terms, found again on every check. */
export interface LocatedTarget {
  label: string
  locate: (page: Page) => Locator
}

export interface PrivacyReport {
  host: string
  /** The schema entry that matched the site, if any. */
  platform: string | null
  /** Private elements currently greyed out, by schema rule. */
  veiled: { rule: string; count: number }[]
  /** Elements exempted because the tutorial is about them. */
  kept: number
  /** Pieces of personal data in text covered with a bar, by kind. */
  covered: Record<string, number>
  /** Personal form fields showing dots. */
  fields: number
  /** Clutter taken out of the picture. */
  hidden: string[]
  /** Dialogs answered on the viewer's behalf. */
  prompts: string[]
  /** The cookie banner found and how it was answered, if there was one. */
  consent: { cmp: string; done: boolean } | null
}

const RuleShape = z.object({ name: z.string(), selector: z.string() })
const PromptShape = z.object({
  name: z.string(),
  container: z.string(),
  text: z.string(),
  dismiss: z.string(),
  path: z.string().optional(),
})
const PartShape = z.object({
  private: z.array(RuleShape).default([]),
  hidden: z.array(RuleShape).default([]),
  prompts: z.array(PromptShape).default([]),
})
const SchemaShape = z.object({
  generic: PartShape,
  platforms: z.array(PartShape.extend({ name: z.string(), hosts: z.array(z.string()).min(1) })),
})
export type PlatformSchema = z.infer<typeof SchemaShape>

export function loadPlatformSchema(config: Config): PlatformSchema {
  const file = path.join(config.paths.assets, 'privacy', 'platforms.json')
  return SchemaShape.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
}

/** Autoconsent's self-contained build: it runs in the page and needs nothing from here. */
export function autoconsentScript(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const file = path.join(
      path.dirname(require.resolve('@duckduckgo/autoconsent')),
      'autoconsent.standalone.js',
    )
    return fs.existsSync(file) ? file : null
  } catch {
    return null
  }
}

export function autoconsentVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const main = require.resolve('@duckduckgo/autoconsent')
    const manifest = path.join(path.dirname(main), '..', 'package.json')
    return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string }).version
  } catch {
    return null
  }
}

export interface Detection {
  kind: 'email' | 'secret' | 'iban' | 'card' | 'phone'
  index: number
  length: number
}

/**
 * Finds personal data in a piece of text.
 *
 * Self-contained, because the same function is shipped into the page as source text
 * and also tested here directly. Everything it can confirm, it does: card numbers
 * must pass the Luhn check and IBANs their mod-97 check, which is what keeps an order
 * number or a timestamp from being covered.
 */
export function createDetector(): { find(text: string): Detection[] } {
  const PATTERN = new RegExp(
    [
      '(?<email>[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,})',
      '(?<secret>\\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{10,}|\\bsk-(?:proj-|ant-)?[0-9A-Za-z_-]{20,}' +
        '|\\bgh[pousr]_[0-9A-Za-z]{30,}|\\bgithub_pat_[0-9A-Za-z_]{30,}|\\bxox[abprs]-[0-9A-Za-z-]{10,}' +
        '|\\bAKIA[0-9A-Z]{16}\\b|\\bAIza[0-9A-Za-z_-]{35}' +
        '|\\beyJ[0-9A-Za-z_-]{10,}\\.[0-9A-Za-z_-]{10,}\\.[0-9A-Za-z_-]{10,})',
      '(?<iban>\\b[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\\b)',
      '(?<card>\\b\\d(?:[ -]?\\d){12,18}\\b)',
      '(?<phone>(?:\\+|\\b00)[1-9]\\d{0,3}(?:[ ./-]?\\(0\\))?(?:[ ./-]?\\d){6,14}\\b' +
        '|\\b0\\d{2,5}(?:[ /-]\\d{2,}){1,3}\\b)',
    ].join('|'),
    'g',
  )

  const digits = (value: string) => value.replace(/\D/g, '')

  const luhn = (value: string) => {
    const d = digits(value)
    let sum = 0
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i])
      if (i % 2 === 1) {
        n *= 2
        if (n > 9) n -= 9
      }
      sum += n
    }
    return d.length >= 13 && d.length <= 19 && sum % 10 === 0
  }

  const ibanValid = (value: string) => {
    const compact = value.replace(/ /g, '')
    if (compact.length < 15 || compact.length > 34) return false
    const moved = compact.slice(4) + compact.slice(0, 4)
    let remainder = 0
    for (const ch of moved) {
      const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch
      for (const c of code) remainder = (remainder * 10 + Number(c)) % 97
    }
    return remainder === 1
  }

  return {
    find(text: string): Detection[] {
      const found: Detection[] = []
      for (const m of text.matchAll(PATTERN)) {
        const groups = m.groups ?? {}
        const kind = (['email', 'secret', 'iban', 'card', 'phone'] as const).find(k => groups[k])
        if (!kind || m.index === undefined) continue
        const value = m[0]
        if (kind === 'card' && !luhn(value)) continue
        if (kind === 'iban' && !ibanValid(value)) continue
        if (kind === 'phone') {
          // A number written without its country code needs nine digits: fewer, and an
          // ISSN ("0413-4360", printed on every newspaper's site) passes for one.
          const count = digits(value).length
          const international = /^(\+|00)/.test(value)
          if (count < (international ? 8 : 9) || count > 15) continue
        }
        found.push({ kind, index: m.index, length: value.length })
      }
      return found
    },
  }
}

interface EngineConfig {
  veil: boolean
  generic: PlatformSchema['generic']
  platforms: PlatformSchema['platforms']
  options: VeilOptions
}

/**
 * The part that runs inside every page and frame.
 *
 * Shipped as source text, so it may use nothing from this module - the detector is
 * handed in as its second argument. Everything is recomputed from a MutationObserver,
 * whose callback runs before the browser paints the change it reports: a message
 * arriving in a chat is covered in the same frame it first appears in.
 */
function veilEngine(cfg: EngineConfig, makeDetector: typeof createDetector): void {
  const w = window as unknown as Record<string, unknown>
  if (w.__tcPrivacy) return

  const host = location.hostname.replace(/^www\./, '')
  const onHost = (hosts: string[]) => hosts.some(h => host === h || host.endsWith(`.${h}`))
  const platforms = cfg.platforms.filter(p => onHost(p.hosts))
  const valid = (selector: string) => {
    try {
      document.createDocumentFragment().querySelector(selector)
      return true
    } catch {
      return false
    }
  }

  const privateRules = cfg.veil
    ? [...cfg.generic.private, ...platforms.flatMap(p => p.private)].filter(r => valid(r.selector))
    : []
  const hiddenRules = cfg.veil
    ? [...cfg.generic.hidden, ...platforms.flatMap(p => p.hidden)].filter(r => valid(r.selector))
    : []
  const prompts = (cfg.veil ? [...cfg.generic.prompts, ...platforms.flatMap(p => p.prompts)] : [])
    .filter(p => valid(p.container))
    .map(p => ({
      name: p.name,
      container: p.container,
      text: new RegExp(p.text, 'i'),
      dismiss: new RegExp(p.dismiss, 'i'),
      path: p.path ? new RegExp(p.path, 'i') : null,
    }))
  const items = privateRules.map(r => r.selector).join(', ')

  let options: VeilOptions = { hideText: [], hideCss: [], keepCss: [] }
  let custom: RegExp | null = null
  const detector = makeDetector()

  // Drained of colour, blurred past reading and dimmed: greyed out, but plainly still
  // there, so the viewer sees that something was left out rather than a broken page.
  // Going into the veil is instant; only coming out of it is animated.
  const VEIL =
    'filter: blur(max(8px, .5em)) grayscale(1) !important; opacity: .5 !important; transition: none !important;'
  const PERSONAL_FIELDS = [
    '[type="email" i]',
    '[type="tel" i]',
    ...[
      'email', 'tel', 'tel-national', 'username', 'name', 'given-name', 'family-name',
      'street-address', 'address-line1', 'address-line2', 'postal-code', 'cc-number',
      'cc-name', 'cc-csc', 'cc-exp', 'bday', 'one-time-code',
    ].map(token => `[autocomplete~="${token}" i]`),
    '[name*="email" i]',
    '[name*="phone" i]',
    '[name*="iban" i]',
  ].join(', ')

  const sheet = new CSSStyleSheet()
  const ensureSheet = () => {
    if (!document.adoptedStyleSheets.includes(sheet)) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    }
  }
  const rebuildSheet = () => {
    const rules: string[] = []
    if (items) {
      const kept = '[data-tc-keep], [data-tc-keep] *, :has([data-tc-keep])'
      rules.push(`:is(${items}):not(${kept}) { ${VEIL} }`)
      rules.push(`:where(${items}):is(${kept}) { transition: filter .45s ease, opacity .45s ease; }`)
    }
    const hideCss = options.hideCss.filter(valid)
    rules.push(`${hideCss.length ? `:is(${hideCss.join(', ')}), ` : ''}[data-tc-hide] { ${VEIL} }`)
    if (hiddenRules.length) {
      rules.push(`:is(${hiddenRules.map(r => r.selector).join(', ')}) { display: none !important; }`)
    }
    if (cfg.veil) {
      const exempt = ':not([data-tc-keep="agent"], [data-tc-keep="agent"] *)'
      rules.push(
        `input:is(${PERSONAL_FIELDS})${exempt}, input[data-tc-pii]${exempt} { -webkit-text-security: disc !important; }`,
      )
      rules.push(`textarea[data-tc-pii]${exempt} { ${VEIL} }`)
    }
    rules.push(
      '::highlight(tc-private) { color: transparent; -webkit-text-fill-color: transparent; ' +
        'background-color: #8b95a0; text-shadow: none; text-decoration: none; }',
    )
    rules.push('[data-tc-prompt] { visibility: hidden !important; }')
    sheet.replaceSync(rules.join('\n'))
  }

  // --- personal data in text --------------------------------------------------------
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  const HighlightType = (w as { Highlight?: new () => Set<Range> }).Highlight
  const highlight = HighlightType ? new HighlightType() : null
  if (registry && highlight) registry.set('tc-private', highlight)
  const ranges = new WeakMap<Text, Range[]>()
  const kinds = new WeakMap<Range, string>()
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA'])

  const scanText = (node: Text) => {
    if (!highlight) return
    const old = ranges.get(node)
    if (old) {
      for (const r of old) highlight.delete(r)
      ranges.delete(node)
    }
    const parent = node.parentElement
    const text = node.data
    if (!parent || SKIP.has(parent.tagName) || text.length < 2) return
    const found: Range[] = []
    const cover = (index: number, length: number, kind: string) => {
      const r = new Range()
      kinds.set(r, kind)
      r.setStart(node, index)
      r.setEnd(node, index + length)
      highlight.add(r)
      found.push(r)
    }
    if (cfg.veil && text.length >= 6 && !parent.closest('[data-tc-keep="agent"]')) {
      for (const d of detector.find(text)) cover(d.index, d.length, d.kind)
    }
    if (custom) {
      custom.lastIndex = 0
      for (const m of text.matchAll(custom)) cover(m.index ?? 0, m[0].length, 'named word')
    }
    if (found.length) ranges.set(node, found)
  }

  const checkField = (field: HTMLInputElement | HTMLTextAreaElement) => {
    if (!cfg.veil && !custom) return
    const value = field.value
    let personal = false
    if (value) {
      if (cfg.veil && detector.find(value).length > 0) personal = true
      if (custom) {
        custom.lastIndex = 0
        if (custom.test(value)) personal = true
      }
    }
    if (personal) field.setAttribute('data-tc-pii', '')
    else if (field.hasAttribute('data-tc-pii')) field.removeAttribute('data-tc-pii')
  }

  const scan = (root: Node) => {
    if (root.nodeType === Node.TEXT_NODE) return scanText(root as Text)
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) scanText(n as Text)
      else if ((n as Element).tagName === 'INPUT' || (n as Element).tagName === 'TEXTAREA') {
        checkField(n as HTMLInputElement)
      }
    }
  }

  // --- what the tutorial is about ---------------------------------------------------
  const markKeeps = (root: Node) => {
    if (!options.keepCss.length || !(root instanceof Element || root instanceof Document)) return false
    let marked = false
    for (const selector of options.keepCss) {
      if (!valid(selector)) continue
      const found = Array.from(root.querySelectorAll(selector))
      if (root instanceof Element && root.matches(selector)) found.push(root)
      for (const el of found) {
        if (el.getAttribute('data-tc-keep') !== 'agent') {
          el.setAttribute('data-tc-keep', 'agent')
          marked = true
        }
      }
    }
    return marked
  }

  // --- sign-in prompts ----------------------------------------------------------------
  const answered = new WeakSet<Element>()
  const promptLog: string[] = []
  const checkPrompts = () => {
    for (const p of prompts) {
      if (p.path && !p.path.test(location.pathname)) continue
      for (const box of Array.from(document.querySelectorAll(p.container))) {
        if (answered.has(box) || !p.text.test(box.textContent ?? '')) continue
        // A close button often has no text, only a label for screen readers.
        const label = (b: HTMLElement) =>
          (b.textContent ?? '').trim() ||
          b.getAttribute('aria-label') ||
          b.querySelector('[aria-label]')?.getAttribute('aria-label') ||
          ''
        const button = Array.from(box.querySelectorAll<HTMLElement>('button, [role="button"], a')).find(b =>
          p.dismiss.test(label(b)),
        )
        // A prompt that cannot be answered is left alone: hidden but still modal, it
        // would leave the page unusable.
        if (!button) continue
        answered.add(box)
        box.setAttribute('data-tc-prompt', p.name)
        promptLog.push(p.name)
        let tries = 0
        const press = () => {
          if (!button.isConnected || tries++ > 6) return
          button.click()
          setTimeout(press, 400)
        }
        setTimeout(press, 250)
      }
    }
  }

  const rescanAll = () => {
    if (document.documentElement) scan(document.documentElement)
  }

  const observer = new MutationObserver(records => {
    ensureSheet()
    let keepsChanged = false
    for (const r of records) {
      if (r.type === 'characterData') scanText(r.target as Text)
      else {
        for (const n of Array.from(r.addedNodes)) {
          if (markKeeps(n)) keepsChanged = true
          scan(n)
        }
      }
    }
    if (keepsChanged) rescanAll()
    if (prompts.length) checkPrompts()
  })
  observer.observe(document, { childList: true, subtree: true, characterData: true })
  document.addEventListener(
    'input',
    event => {
      const t = event.target as Element | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) checkField(t as HTMLInputElement)
    },
    true,
  )

  const setOptions = (next: VeilOptions) => {
    options = next
    const words = next.hideText.map(s => s.trim()).filter(s => s.length >= 2)
    custom = words.length
      ? new RegExp(words.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
      : null
    rebuildSheet()
    markKeeps(document)
    rescanAll()
  }

  // What autoconsent, running beside this in the same page, has said so far. Only a
  // banner actually on screen counts: a consent tool that is present but already
  // answered, from an earlier visit, is not news.
  const consentMessages = () => {
    const messages =
      (w.autoconsentStandalone as
        | { messages?: { type: string; cmp?: string; state?: { lifecycle?: string } }[] }
        | undefined)?.messages ?? []
    let lifecycle: string | undefined
    for (const m of messages) if (m.type === 'report') lifecycle = m.state?.lifecycle
    return {
      popup: messages.find(m => m.type === 'popupFound'),
      done: messages.find(m => ['autoconsentDone', 'optOutResult', 'autoconsentError'].includes(m.type)),
      // A consent tool is on the page and its banner may be about to open.
      detected: lifecycle === 'cmpDetected' || lifecycle === 'openPopupDetected',
    }
  }

  const visible = (el: Element) => el.getClientRects().length > 0
  const isKept = (el: Element) => Boolean(el.closest('[data-tc-keep]') || el.querySelector('[data-tc-keep]'))

  Object.defineProperty(w, '__tcPrivacy', {
    enumerable: false,
    value: {
      setOptions,
      /** The tutorial is about this element: keep its whole private unit visible. */
      keepAuto(el: Element) {
        const unit = items ? el.closest(items) : null
        const target = unit ?? el
        if (!target.hasAttribute('data-tc-keep')) target.setAttribute('data-tc-keep', 'auto')
      },
      mark(el: Element, kind: 'keep' | 'hide') {
        if (kind === 'hide') el.setAttribute('data-tc-hide', '')
        else if (el.getAttribute('data-tc-keep') !== 'agent') {
          el.setAttribute('data-tc-keep', 'agent')
          rescanAll()
        }
      },
      report() {
        const veiled: { rule: string; count: number }[] = []
        for (const rule of privateRules) {
          // Counted once where a platform nests one matching element in another.
          const count = Array.from(document.querySelectorAll(rule.selector)).filter(
            e => visible(e) && !isKept(e) && !e.parentElement?.closest(rule.selector),
          ).length
          if (count) veiled.push({ rule: rule.name, count })
        }
        const covered: Record<string, number> = {}
        if (highlight) {
          for (const r of highlight) {
            if (r.collapsed) continue
            const kind = kinds.get(r) ?? 'text'
            covered[kind] = (covered[kind] ?? 0) + 1
          }
        }
        const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input, textarea')).filter(
          f => f.value && (f.hasAttribute('data-tc-pii') || f.matches(`input:is(${PERSONAL_FIELDS})`)),
        ).length
        const hidden = hiddenRules.filter(r => document.querySelector(r.selector)).map(r => r.name)
        const { popup, done } = consentMessages()
        return {
          host,
          platform: platforms[0]?.name ?? null,
          veiled,
          kept: document.querySelectorAll('[data-tc-keep]').length,
          covered,
          fields,
          hidden,
          prompts: [...promptLog],
          consent: popup ? { cmp: popup.cmp ?? 'unknown', done: Boolean(done) } : null,
        }
      },
      /** Whether a cookie banner was found here, and whether it has been answered. */
      consentState(): 'none' | 'detected' | 'pending' | 'done' {
        const { popup, done, detected } = consentMessages()
        if (popup) return done ? 'done' : 'pending'
        return detected ? 'detected' : 'none'
      },
    },
  })

  ensureSheet()
  setOptions(cfg.options)
  // Collapsed ranges are left behind by text that was removed; clear them out now and
  // then so a long session does not accumulate them.
  setInterval(() => {
    if (highlight) for (const r of [...highlight]) if (r.collapsed) highlight.delete(r)
  }, 5000)
}

/** The source text shipped into every page for these settings. */
export function engineScript(schema: PlatformSchema, veil: boolean, options: VeilOptions): string {
  const cfg: EngineConfig = { veil, generic: schema.generic, platforms: schema.platforms, options }
  return `(${veilEngine.toString()})(${JSON.stringify(cfg)}, ${createDetector.toString()});`
}

const EMPTY_OPTIONS: VeilOptions = { hideText: [], hideCss: [], keepCss: [] }

type ConsentState = 'none' | 'detected' | 'pending' | 'done'

/**
 * One browser's privacy layer, seen from the recording session.
 *
 * Elements named in plain CSS are handled in the page, instantly and for good.
 * Elements named in Playwright's terms - a role and a name, a piece of text - can only
 * be found from here, so they are marked, and marked again every second: an app that
 * re-renders them drops the mark, and a new page has none.
 */
export class Privacy {
  private readonly context: BrowserContext
  private readonly settings: PrivacySettings
  private options: VeilOptions = EMPTY_OPTIONS
  private keepTargets: LocatedTarget[] = []
  private hideTargets: LocatedTarget[] = []
  private readonly timer: NodeJS.Timeout

  private constructor(context: BrowserContext, settings: PrivacySettings) {
    this.context = context
    this.settings = settings
    this.timer = setInterval(() => void this.remark(), 1000)
    this.timer.unref()
    context.on('close', () => clearInterval(this.timer))
  }

  static async install(
    context: BrowserContext,
    config: Config,
    settings: PrivacySettings,
    options: VeilOptions = EMPTY_OPTIONS,
  ): Promise<Privacy> {
    const privacy = new Privacy(context, settings)
    privacy.options = options
    if (settings.cookies) {
      const script = autoconsentScript()
      if (script) await context.addInitScript({ path: script })
      else log.warn('Cookie banners will not be answered: @duckduckgo/autoconsent is not installed')
    }
    await context.addInitScript(engineScript(loadPlatformSchema(config), settings.veil, options))
    return privacy
  }

  get cookies(): boolean {
    return this.settings.cookies
  }

  get veil(): boolean {
    return this.settings.veil
  }

  /** Replace what the tutorial has asked to keep and to hide. */
  async update(options: VeilOptions, keep: LocatedTarget[], hide: LocatedTarget[]): Promise<void> {
    this.options = options
    this.keepTargets = keep
    this.hideTargets = hide
    // Every new document starts from the engine's first options; this brings it up to
    // date before anything is painted. The last one added runs last, so it wins.
    const script = `window.__tcPrivacy && window.__tcPrivacy.setOptions(${JSON.stringify(options)});`
    await this.context.addInitScript(script)
    for (const page of this.context.pages()) {
      for (const frame of page.frames()) {
        await frame.evaluate(script).catch(() => {})
      }
    }
    await this.remark()
  }

  /**
   * Wait while a cookie banner is still being answered, and then for the page the
   * answer reloads into - several sites save the choice and reload.
   *
   * Autoconsent only gives up looking for a banner after ten seconds or so, too long to
   * wait for on every page. So: `graceMs` is how long a banner is given to turn up at
   * all; a consent tool that has been recognised gets three seconds more to open its
   * banner (Sourcepoint's opens two seconds after the page has loaded); a banner that
   * is open is waited for until it has been answered. `reloadMs` allows for the reload.
   * The grace and the reload are worth it off camera, where waiting costs the video
   * nothing; on camera a banner is hidden while it is answered.
   */
  async settle(
    page: Page,
    { graceMs = 0, reloadMs = 3000, timeoutMs = 15_000 } = {},
  ): Promise<void> {
    if (!this.settings.cookies) return
    const started = Date.now()
    const deadline = started + timeoutMs
    let answered = false
    let detectedSince: number | null = null
    let navigated = false
    const onNavigation = (frame: Frame) => {
      if (frame === page.mainFrame()) navigated = true
    }
    page.on('framenavigated', onNavigation)
    try {
      while (Date.now() < deadline) {
        const state = await this.consentState(page)
        if (state === 'pending' || state === 'done') answered = true
        const waiting =
          state === 'pending' ||
          (state === 'detected' && Date.now() - (detectedSince ??= Date.now()) < 3000) ||
          (state === 'none' && Date.now() - started < graceMs)
        if (!waiting) break
        await page.waitForTimeout(250)
      }
      if (!answered) return
      // The choice is often saved and the page reloaded a moment after the click.
      const reloadBy = Math.min(deadline, Date.now() + reloadMs)
      while (!navigated && Date.now() < reloadBy) await page.waitForTimeout(200)
      await page
        .waitForLoadState('load', { timeout: Math.max(1000, deadline - Date.now()) })
        .catch(() => {})
      if (navigated) await page.waitForTimeout(600)
    } finally {
      page.off('framenavigated', onNavigation)
    }
  }

  /** The most pressing consent state of any frame on the page. */
  private async consentState(page: Page): Promise<ConsentState> {
    const rank: ConsentState[] = ['none', 'done', 'detected', 'pending']
    let state: ConsentState = 'none'
    for (const frame of page.frames()) {
      const found = await frame
        .evaluate(() => {
          const api = (window as unknown as { __tcPrivacy?: { consentState(): ConsentState } }).__tcPrivacy
          return api ? api.consentState() : 'none'
        })
        .catch(() => 'none' as const)
      if (rank.indexOf(found) > rank.indexOf(state)) state = found
    }
    return state
  }

  /** The tutorial acts on this element: keep its whole private unit visible. */
  async keepAuto(locator: Locator): Promise<void> {
    await locator
      .evaluate(el => {
        const api = (window as unknown as { __tcPrivacy?: { keepAuto(e: Element): void } }).__tcPrivacy
        api?.keepAuto(el)
      }, undefined, { timeout: 2000 })
      .catch(() => {})
  }

  private async remark(): Promise<void> {
    if (!this.keepTargets.length && !this.hideTargets.length) return
    for (const page of this.context.pages()) {
      const marks: [LocatedTarget, 'keep' | 'hide'][] = [
        ...this.keepTargets.map(t => [t, 'keep'] as [LocatedTarget, 'keep']),
        ...this.hideTargets.map(t => [t, 'hide'] as [LocatedTarget, 'hide']),
      ]
      for (const [target, kind] of marks) {
        await target
          .locate(page)
          .evaluateAll((els, k) => {
            const api = (window as unknown as { __tcPrivacy?: { mark(e: Element, k: string): void } })
              .__tcPrivacy
            for (const el of els) api?.mark(el, k)
          }, kind)
          .catch(() => {})
      }
    }
  }

  /** What is being kept out of the picture on this page right now, frames included. */
  async report(page: Page): Promise<PrivacyReport | null> {
    const reports: PrivacyReport[] = []
    for (const frame of page.frames()) {
      const r = await frame
        .evaluate(() => {
          const api = (window as unknown as { __tcPrivacy?: { report(): unknown } }).__tcPrivacy
          return api ? api.report() : null
        })
        .catch(() => null)
      if (r) reports.push(r as PrivacyReport)
    }
    const [main, ...frames] = reports
    if (!main) return null
    const merged: PrivacyReport = {
      ...main,
      veiled: [...main.veiled],
      covered: { ...main.covered },
      hidden: [...main.hidden],
      prompts: [...main.prompts],
    }
    for (const f of frames) {
      for (const [kind, n] of Object.entries(f.covered)) merged.covered[kind] = (merged.covered[kind] ?? 0) + n
      merged.fields += f.fields
      merged.kept += f.kept
      for (const v of f.veiled) {
        const same = merged.veiled.find(x => x.rule === v.rule)
        if (same) same.count += v.count
        else merged.veiled.push({ ...v })
      }
      merged.hidden.push(...f.hidden.filter(h => !merged.hidden.includes(h)))
      merged.prompts.push(...f.prompts)
      if (!merged.consent || (!merged.consent.done && f.consent?.done)) merged.consent = f.consent ?? merged.consent
    }
    return merged
  }
}

/** The report as a few lines for a tool result. */
export function describePrivacy(report: PrivacyReport | null): string {
  if (!report) return 'Privacy: not active on this page.'
  const lines: string[] = []
  if (report.consent) {
    lines.push(
      report.consent.done
        ? `Cookie banner (${report.consent.cmp}) answered with "reject".`
        : `Cookie banner (${report.consent.cmp}) found, still being answered.`,
    )
  }
  const veiled = report.veiled.reduce((sum, v) => sum + v.count, 0)
  if (veiled) {
    lines.push(
      `Greyed out on ${report.host}${report.platform ? ` (${report.platform})` : ''}: ` +
        report.veiled.map(v => `${v.count} ${v.rule}`).join(', ') +
        '. Whatever is clicked, typed into or highlighted stays visible; keep more with tutorial_privacy.',
    )
  }
  if (report.kept) lines.push(`Kept visible: ${report.kept} element(s).`)
  const covered = Object.entries(report.covered)
  if (covered.length) {
    lines.push(`Covered with a bar: ${covered.map(([kind, n]) => `${n} ${kind}`).join(', ')}.`)
  }
  if (report.fields) lines.push(`Personal form fields showing dots: ${report.fields}.`)
  if (report.hidden.length) lines.push(`Hidden: ${report.hidden.join(', ')}.`)
  if (report.prompts.length) lines.push(`Answered "Not now": ${report.prompts.join(', ')}.`)
  return lines.length ? lines.join('\n') : `Nothing private found on ${report.host}.`
}
