/**
 * Importing a signed-in session from the browser the user actually uses.
 *
 * Asking someone to sign in again, by hand, into a second browser makes no sense
 * when their real Chrome is already signed in everywhere. An agent that has just
 * walked through an app with the Playwright MCP can export that session and hand it
 * to the recorder, so recording needs no separate login step.
 *
 * The hand-off goes through a file rather than through the conversation: a session
 * export is a credential dump, and anything returned by a tool is written into the
 * transcript. The file is consumed once and deleted immediately.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Cookie } from 'playwright-core'
import type { Config } from './env.js'
import { launchBrowser } from './browser.js'
import { log } from './logger.js'

/** Playwright's `storageState()` output. */
interface StorageState {
  cookies?: Array<{
    name: string
    value: string
    domain: string
    path: string
    expires: number
    httpOnly: boolean
    secure: boolean
    sameSite: 'Strict' | 'Lax' | 'None'
  }>
  origins?: Array<{
    origin: string
    localStorage?: Array<{ name: string; value: string }>
  }>
}

export interface ImportOptions {
  /** Path to a `storageState()` JSON file. */
  stateFile: string
  /** Target profile under `profiles/`. */
  profile: string
  /**
   * Only import cookies for these hosts. Strongly recommended: a full export
   * carries every site the user is signed into, and a tutorial needs one.
   */
  domains?: string[]
  /** Delete the export after reading it. Defaults to true. */
  deleteSourceFile?: boolean
  /** Optional page to open afterwards to confirm the session actually carried. */
  verifyUrl?: string
}

export interface ImportResult {
  imported: number
  skipped: number
  /** Domains that contributed cookies, with counts. Never any values. */
  byDomain: Array<{ domain: string; count: number }>
  localStorageOrigins: number
  /** No page storage for the requested hosts - usually means the site was not open. */
  missingPageStorage: boolean
  sourceDeleted: boolean
  verification: {
    url: string
    title: string
    looksSignedIn: boolean
    redirectedToLogin: boolean
    conclusive: boolean
  } | null
}

/** Does `domain` (which may start with a dot) belong to `host`? */
function domainMatches(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase()
  const h = host.replace(/^\./, '').toLowerCase()
  return d === h || d.endsWith(`.${h}`) || h.endsWith(`.${d}`)
}

/** Extract a bare host from whatever the caller passed (URL or host). */
function toHost(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname
  } catch {
    return value.replace(/^\./, '')
  }
}

export async function importSession(
  config: Config,
  options: ImportOptions,
): Promise<ImportResult> {
  const file = path.resolve(options.stateFile)
  if (!fs.existsSync(file)) {
    throw new Error(
      `No session export at ${file}. Produce one from the signed-in browser with ` +
        "`await page.context().storageState({ path: '<file>' })`.",
    )
  }

  let state: StorageState
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8')) as StorageState
  } catch (err) {
    throw new Error(`${file} is not a readable storageState file: ${(err as Error).message}`)
  }

  const all = state.cookies ?? []
  const hosts = (options.domains ?? []).map(toHost).filter(Boolean)
  const wanted =
    hosts.length > 0 ? all.filter(c => hosts.some(h => domainMatches(c.domain, h))) : all

  if (wanted.length === 0) {
    throw new Error(
      hosts.length > 0
        ? `The export holds no cookies for ${hosts.join(', ')}. ` +
          'Was the site actually open and signed in?'
        : 'The export holds no cookies at all.',
    )
  }

  // Playwright rejects a cookie whose expiry is in the past, and session cookies
  // arrive as -1, which is valid and means "until the browser closes".
  const now = Date.now() / 1000
  const usable = wanted.filter(c => c.expires === -1 || c.expires > now)
  const cookies: Cookie[] = usable.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }))

  const counts = new Map<string, number>()
  for (const c of cookies) {
    const d = c.domain.replace(/^\./, '')
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }

  // Write the cookies into the profile: Chromium persists them on close.
  const { context, page } = await launchBrowser(config, {
    profile: options.profile,
    width: 1280,
    height: 720,
    headless: true,
  })

  // Page storage relevant to the hosts we were asked for.
  const relevantOrigins = (state.origins ?? []).filter(o => {
    if (!o.localStorage?.length) return false
    if (hosts.length === 0) return true
    try {
      return hosts.some(h => domainMatches(new URL(o.origin).hostname, h))
    } catch {
      return false
    }
  })

  let importedOrigins = 0
  let verification: ImportResult['verification'] = null
  try {
    await context.addCookies(cookies)
    log.info(`Imported ${cookies.length} cookies into profile "${options.profile}"`)

    // localStorage belongs to an origin, so it can only be written while that
    // origin is loaded. Many apps keep their auth token here rather than in a
    // cookie, which is why this is not optional.
    for (const origin of relevantOrigins) {
      try {
        await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 25_000 })
        const written = await page.evaluate(entries => {
          let n = 0
          for (const { name, value } of entries) {
            try {
              window.localStorage.setItem(name, value)
              n++
            } catch {
              /* storage disabled or quota exceeded for this origin */
            }
          }
          return n
        }, origin.localStorage ?? [])
        importedOrigins++
        log.info(`Restored ${written} storage entries for ${origin.origin}`)
      } catch (err) {
        log.warn(`Could not restore page storage for ${origin.origin}`, err)
      }
    }

    if (options.verifyUrl) {
      await page.goto(options.verifyUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForTimeout(1500)
      const title = await page.title()
      const landed = page.url()

      // Two signals, because either alone is unreliable. A public page has no
      // password field whether or not anyone is signed in, so absence proves
      // nothing on its own; and some apps render a login form in place rather than
      // redirecting. Being bounced to a sign-in URL is the stronger signal, so
      // check that first and only fall back to the form check.
      const bounced = /\/(login|signin|sign-in|auth|sso|account\/login)\b/i.test(landed)
      const passwordFields = await page
        .locator('input[type="password"]:visible')
        .count()
        .catch(() => 0)

      verification = {
        url: landed,
        title,
        looksSignedIn: !bounced && passwordFields === 0,
        redirectedToLogin: bounced,
        // A verify URL that is reachable without an account cannot tell us
        // anything; say so instead of implying a clean result.
        conclusive: bounced || passwordFields > 0 || landed === options.verifyUrl,
      }
    }
  } finally {
    await context.close().catch(() => {})
  }

  let sourceDeleted = false
  if (options.deleteSourceFile !== false) {
    try {
      fs.rmSync(file, { force: true })
      sourceDeleted = !fs.existsSync(file)
    } catch (err) {
      log.warn(`Could not delete the session export at ${file}`, err)
    }
  }

  return {
    imported: cookies.length,
    skipped: all.length - cookies.length,
    byDomain: [...counts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count),
    localStorageOrigins: importedOrigins,
    /**
     * True when the export contained no page storage for the requested hosts.
     *
     * This is almost always because the exporting browser had not actually opened
     * the site: `storageState()` only collects localStorage for origins that are
     * loaded in the context. Apps that keep their login token in page storage will
     * then appear signed out for no obvious reason - so it is called out rather
     * than left to be discovered during a recording.
     */
    missingPageStorage: relevantOrigins.length === 0,
    sourceDeleted,
    verification,
  }
}

/** Profiles that exist, with a rough idea of whether they hold anything. */
export function listProfiles(config: Config): Array<{ name: string; hasData: boolean }> {
  const dir = config.paths.profiles
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({
      name: d.name,
      hasData: fs.existsSync(path.join(dir, d.name, 'Default', 'Cookies')),
    }))
}
