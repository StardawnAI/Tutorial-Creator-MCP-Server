#!/usr/bin/env node
/**
 * Unattended sign-in for a tutorial browser profile.
 *
 * `npm run login` opens a window and waits for a person to type their password by
 * hand. That does not scale to a recording that has to run on its own, and re-runs
 * every time a Windows account change or a cleared profile drops the session (see
 * docs/STATUS.md, 2026-09-28). This does the same job without a person: it drives
 * the site's own login form with a username, a password and - if the account has
 * two-factor - a code computed from a stored secret, all read from environment
 * variables, never from a command-line argument or a log line. The session lands in
 * the same profile directory `npm run login` and the recorder use, so a recording
 * started right after finds itself already signed in.
 *
 * The credentials are asked for once and kept in .env, exactly like ADMIN_PASSWORD
 * and the HeyGen key already are - never printed, never committed. From then on every
 * future recording signs itself in with no one present, including recovering on its
 * own if a Windows account change or a cleared profile wipes the session again.
 *
 * Several accounts on the same site each get their own profile and their own
 * variables, named after the profile: a profile "instagram-customer" reads
 * IG_USERNAME_INSTAGRAM_CUSTOMER and IG_PASSWORD_INSTAGRAM_CUSTOMER (and
 * IG_TOTP_SECRET_INSTAGRAM_CUSTOMER if that account has two-factor).
 *
 * Idempotent: if the profile is already signed in (its session cookie is present
 * and the page does not show a login form), this verifies that and exits at once -
 * safe to run before every recording.
 *
 *   npm run autologin -- --site instagram --profile instagram-customer
 *
 * Add a site by extending SITES below with its login URL, field selectors, and how
 * to tell a successful sign-in from a failed one.
 */

import { loadConfig } from '../lib/env.js'
import { launchBrowser } from '../lib/browser.js'
import { currentCode } from '../lib/totp.js'
import { autoconsentScript } from '../lib/privacy.js'
import type { Page } from 'playwright-core'

interface SiteLogin {
  /** Where the login form is. */
  loginUrl: string
  /** A cookie that only exists once signed in - the fast, idempotent check. */
  sessionCookie: { name: string; domain: string }
  usernameSelector: string
  passwordSelector: string
  submitSelector: string
  /** Prefix for this site's per-profile .env variables, e.g. "IG" -> IG_USERNAME_<PROFILE>. */
  envPrefix: string
  /** Shown after a password is submitted, only if the site asks for it. */
  totpSelector?: string
  totpSubmitSelector?: string
  /** Prompts Instagram (and similar sites) show right after a fresh sign-in. */
  afterLogin?: Array<{ selector: string; action: 'click' | 'dismiss' }>
}

const SITES: Record<string, SiteLogin> = {
  instagram: {
    loginUrl: 'https://www.instagram.com/accounts/login/',
    sessionCookie: { name: 'sessionid', domain: 'instagram.com' },
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    envPrefix: 'IG',
    totpSelector: 'input[name="verificationCode"], input[aria-label*="ecurity code" i]',
    totpSubmitSelector: 'button[type="button"]:has-text("Confirm"), button:has-text("Weiter")',
    afterLogin: [
      { selector: 'button:has-text("Not now"), button:has-text("Jetzt nicht")', action: 'dismiss' },
    ],
  },
}

function parseArgs(argv: string[]): { site: string | null; profile: string | null } {
  let site: string | null = null
  let profile: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--site' && argv[i + 1]) site = argv[++i] ?? null
    else if (arg === '--profile' && argv[i + 1]) profile = argv[++i] ?? null
  }
  return { site, profile }
}

/** IG_USERNAME_INSTAGRAM_CUSTOMER for prefix "IG", profile "instagram-customer". */
function envVarNames(prefix: string, profile: string): { username: string; password: string; totpSecret: string } {
  const suffix = profile.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return {
    username: `${prefix}_USERNAME_${suffix}`,
    password: `${prefix}_PASSWORD_${suffix}`,
    totpSecret: `${prefix}_TOTP_SECRET_${suffix}`,
  }
}

async function isSignedIn(page: Page, site: SiteLogin): Promise<boolean> {
  const cookies = await page.context().cookies(`https://${site.sessionCookie.domain}/`)
  return cookies.some(c => c.name === site.sessionCookie.name)
}

/** Reject cookie banners the same way a recording does, so they never block a field. */
async function rejectCookies(page: Page): Promise<void> {
  const script = autoconsentScript()
  if (script) await page.addInitScript(script).catch(() => {})
  await page.waitForTimeout(1500)
  const reject = page
    .locator('[aria-label*="ablehnen" i], [aria-label*="ecline" i], [aria-label*="eject" i]')
    .first()
  if (await reject.count().catch(() => 0)) {
    await reject.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(500)
  }
}

async function main(): Promise<void> {
  const { site: siteName, profile } = parseArgs(process.argv.slice(2))
  const out = (s: string) => process.stdout.write(`${s}\n`)

  if (!siteName || !SITES[siteName] || !profile) {
    out(`usage: npm run autologin -- --site ${Object.keys(SITES).join('|')} --profile <name>`)
    process.exit(1)
  }
  const site = SITES[siteName]!
  const env = envVarNames(site.envPrefix, profile)

  const username = process.env[env.username]
  const password = process.env[env.password]
  if (!username || !password) {
    out(`${env.username} and ${env.password} must be set in .env (once - never asked again after that).`)
    process.exit(1)
  }

  const config = loadConfig()
  const { context, page } = await launchBrowser(config, {
    profile,
    width: 1440,
    height: 900,
    headless: false,
    deviceScaleFactor: 1,
  })

  try {
    await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded' })
    await rejectCookies(page)

    if (await isSignedIn(page, site)) {
      out(`Profile "${profile}" is already signed in to ${siteName}. Nothing to do.`)
      return
    }

    const userField = page.locator(site.usernameSelector).first()
    if ((await userField.count()) === 0) {
      // No login form and no session cookie: an interstitial or a layout change.
      // A person needs to look at this once - it is not something to guess past.
      throw new Error(
        `${siteName}'s login form did not appear at ${site.loginUrl}. The page may show ` +
          'something unexpected; check it in a visible browser.',
      )
    }

    out(`Signing in to ${siteName} as ${username}...`)
    await userField.click()
    await userField.pressSequentially(username, { delay: 40 })
    await page.locator(site.passwordSelector).first().pressSequentially(password, { delay: 40 })
    await page.locator(site.submitSelector).first().click()

    // A two-factor prompt is optional: only handled if the site actually shows it.
    if (site.totpSelector) {
      const totpField = page.locator(site.totpSelector).first()
      try {
        await totpField.waitFor({ state: 'visible', timeout: 15_000 })
        if (!process.env[env.totpSecret]) {
          throw new Error(
            `${siteName} is asking for a two-factor code, but no ${env.totpSecret} is ` +
              'configured to answer it.',
          )
        }
        const code = await currentCode(env.totpSecret)
        out('Two-factor code requested - typing the current one.')
        await totpField.pressSequentially(code, { delay: 40 })
        if (site.totpSubmitSelector) {
          await page.locator(site.totpSubmitSelector).first().click({ timeout: 5000 }).catch(() => {})
        }
      } catch (err) {
        if ((err as Error).message.includes('two-factor code, but no')) throw err
        // waitFor timed out: the site did not ask this time - carry on.
      }
    }

    // Give the session cookie a moment to land, then answer whatever housekeeping
    // prompt shows up (save login info, turn on notifications, ...).
    await page.waitForTimeout(3000)
    for (const prompt of site.afterLogin ?? []) {
      const el = page.locator(prompt.selector).first()
      if (await el.count().catch(() => 0)) {
        await el.click({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(1000)
      }
    }

    if (!(await isSignedIn(page, site))) {
      throw new Error(
        `Signed in but no ${site.sessionCookie.name} cookie appeared. ${siteName} may have ` +
          'refused the credentials or shown a check this script does not know - look at the ' +
          `window (still open) or a screenshot to see what it is asking.`,
      )
    }
    out(`Signed in. Profile "${profile}" is ready for a recording.`)
  } finally {
    await context.close()
  }
}

main().catch(err => {
  process.stderr.write(`autologin failed: ${(err as Error).message}\n`)
  process.exit(1)
})
