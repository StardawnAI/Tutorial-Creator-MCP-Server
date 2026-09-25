/**
 * Browser lifecycle.
 *
 * The server drives its own Playwright browser rather than attaching to the user's
 * Chrome. That is not a preference: the existing `@playwright/mcp` runs in
 * extension mode and launches Chromium with `--remote-debugging-pipe`, so no second
 * process can speak CDP to it. See docs/ARCHITECTURE.md §2.
 *
 * Logins are carried by a persistent profile directory. The user signs in once via
 * the `login` command; every later recording reuses that profile headlessly.
 *
 * A fresh browser gets an empty profile in a temporary directory instead - the
 * equivalent of a private window, for recordings that have to show a real sign-in.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import type { Config } from './env.js'
import { installHeartbeat } from './heartbeat.js'
import { log } from './logger.js'

export interface LaunchOptions {
  /** Profile name under `profiles/`. Each profile is an independent login set. */
  profile: string
  /** Ignore `profile` and start from an empty throwaway one. */
  fresh?: boolean
  width: number
  height: number
  headless: boolean
  /** Extra pixel density. 2 renders text noticeably crisper. */
  deviceScaleFactor?: number
  locale?: string
  timezoneId?: string
}

export interface LaunchedBrowser {
  context: BrowserContext
  page: Page
  profileDir: string
  /** Set for a throwaway profile: the caller deletes it once the context is closed. */
  disposableDir: string | null
}

/**
 * Flags that keep a background browser painting at full speed. Chromium throttles
 * rendering when it believes nobody is looking, which shows up as a stuttering
 * recording.
 */
const KEEP_PAINTING = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
  '--hide-scrollbars',
  '--mute-audio',
]

/**
 * Flags that stop the browser announcing that it is being driven.
 *
 * `--enable-automation`, which Playwright passes by default, puts "Chrome is being
 * controlled by automated test software" in the window and sets the flag a page can
 * read; `AutomationControlled` is the Blink feature behind `navigator.webdriver`.
 *
 * This raises the threshold; it does not make the browser undetectable, and nothing
 * here defeats a CAPTCHA. Where a sign-in genuinely has to be on camera, expect to
 * answer a security check by hand - see docs/ARCHITECTURE.md.
 */
const LOOK_LIKE_A_PERSON = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
]

/**
 * No proxy discovery.
 *
 * With no proxy configured, Chromium still asks the network whether there is one
 * (WPAD) before its first request, and on this machine nothing answers for 21
 * seconds. Measured on example.com in a new browser: 21.3 s and 21.1 s to the first
 * response, against 0.2 s with discovery off - while name lookup, connection and
 * first byte took under 0.2 s either way. That was the "25 seconds of loading" at the
 * start of a recording.
 *
 * A proxy that is really wanted is still used: set HTTPS_PROXY or HTTP_PROXY and the
 * system settings are left alone, or TUTORIAL_MCP_SYSTEM_PROXY=1 to keep discovery.
 */
function proxyArgs(): string[] {
  const env = process.env
  const wanted = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (wanted || env.TUTORIAL_MCP_SYSTEM_PROXY === '1') return []
  return ['--no-proxy-server']
}

/**
 * The last automation traces a page can read from JavaScript.
 *
 * Kept to the ones that are true statements about a real browser rather than a pile
 * of folklore: a Chrome that is not being driven has no `navigator.webdriver`, has a
 * `window.chrome` object, and reports the languages it is actually running in.
 */
function disguiseScript(locale: string): string {
  const languages = JSON.stringify([locale, locale.split('-')[0]])
  return `
    /* A browser a person drives reports false here, not undefined - claiming the
       property does not exist at all is itself a tell. */
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    if (!window.chrome) window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ${languages} });
  `
}

/**
 * A headless browser says so in its user agent, which is the first thing a bot check
 * looks at. The string is read back from the browser and the word replaced, so the
 * version always matches the browser actually running.
 */
async function hideHeadlessUserAgent(page: Page): Promise<void> {
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '')
  if (!userAgent.includes('HeadlessChrome')) return
  const cdp = await page.context().newCDPSession(page)
  await cdp
    .send('Network.setUserAgentOverride', {
      userAgent: userAgent.replace('HeadlessChrome', 'Chrome'),
    })
    .catch(err => log.warn('Could not replace the headless user agent', err))
}

/** Refuse to touch the user's real Chrome profile - it would be locked and corrupted. */
function assertNotRealChromeProfile(profileDir: string): void {
  const resolved = path.resolve(profileDir).toLowerCase()
  const forbidden = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'User Data'),
  ]
    .filter(p => p.trim().length > 0)
    .map(p => path.resolve(p).toLowerCase())

  for (const bad of forbidden) {
    if (resolved === bad || resolved.startsWith(bad + path.sep)) {
      throw new Error(
        `Refusing to use "${profileDir}": that is a live browser profile. ` +
          'The tutorial browser needs its own profile directory.',
      )
    }
  }
}

export async function launchBrowser(
  config: Config,
  options: LaunchOptions,
): Promise<LaunchedBrowser> {
  const disposableDir = options.fresh
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-fresh-'))
    : null
  const profileDir = disposableDir ?? path.join(config.paths.profiles, options.profile)
  assertNotRealChromeProfile(profileDir)
  fs.mkdirSync(profileDir, { recursive: true })

  if (!config.chromiumPath) {
    throw new Error(
      'No Chromium executable found. Install Playwright browsers with ' +
        '`npx playwright install chromium`, or set TUTORIAL_MCP_CHROMIUM.',
    )
  }

  log.info(
    `Launching ${options.headless ? 'headless' : 'headed'} Chromium ` +
      `(${disposableDir ? 'empty throwaway profile' : `profile "${options.profile}"`}, ` +
      `${options.width}x${options.height})`,
  )

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: config.chromiumPath,
    headless: options.headless,
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    locale: options.locale,
    timezoneId: options.timezoneId,
    args: [...KEEP_PAINTING, ...LOOK_LIKE_A_PERSON, ...proxyArgs()],
    // Every ring, instruction card and keycap is handed to Playwright as HTML, which
    // it puts into the page with innerHTML. A page that enforces Trusted Types -
    // YouTube, Gmail and Google's other apps do - blocks exactly that ("This document
    // requires 'TrustedHTML' assignment"), from Playwright's own isolated world too,
    // so the decorations silently never appeared there. Ignoring the page's
    // Content-Security-Policy is the only switch that reaches them. The price: while
    // recording, a page does without that second line of defence against injected
    // script.
    bypassCSP: true,
    // Playwright adds this one itself; it is the banner that says "automated".
    ignoreDefaultArgs: ['--enable-automation'],
  })
  await context.addInitScript(disguiseScript(options.locale ?? 'en-US'))

  const page = context.pages()[0] ?? (await context.newPage())
  await installHeartbeat(page)
  await hideHeadlessUserAgent(page)

  // Popups and target=_blank pages need the heartbeat too.
  context.on('page', newPage => {
    installHeartbeat(newPage).catch(err => log.warn('Heartbeat install failed', err))
    hideHeadlessUserAgent(newPage).catch(err => log.warn('User-agent override failed', err))
  })

  return { context, page, profileDir, disposableDir }
}
