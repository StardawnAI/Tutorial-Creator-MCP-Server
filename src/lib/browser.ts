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
 */

import fs from 'node:fs'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import type { Config } from './env.js'
import { installHeartbeat } from './heartbeat.js'
import { log } from './logger.js'

export interface LaunchOptions {
  /** Profile name under `profiles/`. Each profile is an independent login set. */
  profile: string
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
  const profileDir = path.join(config.paths.profiles, options.profile)
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
      `(profile "${options.profile}", ${options.width}x${options.height})`,
  )

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: config.chromiumPath,
    headless: options.headless,
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    locale: options.locale,
    timezoneId: options.timezoneId,
    args: KEEP_PAINTING,
  })

  const page = context.pages()[0] ?? (await context.newPage())
  await installHeartbeat(page)

  // Popups and target=_blank pages need the heartbeat too.
  context.on('page', newPage => {
    installHeartbeat(newPage).catch(err => log.warn('Heartbeat install failed', err))
  })

  return { context, page, profileDir }
}
