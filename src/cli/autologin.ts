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
 * The password (and a two-factor secret, if there is one) is asked for once and never
 * typed anywhere this process reads directly: `npm run set-secret -- <Name>` opens its own
 * masked prompt and encrypts the answer with Windows' own DPAPI before anything is written
 * to disk, so the plain value never sits in a file, a chat or this tool's own memory beyond
 * the moment it decrypts it to sign in. See src/lib/secrets.ts. From then on every future
 * recording signs itself in with no one present, including recovering on its own if a
 * Windows account change or a cleared profile wipes the session again.
 *
 * Several accounts on the same site each get their own profile and their own secret name,
 * built from the profile: a profile "instagram-customer" needs IG_PASSWORD_INSTAGRAM_CUSTOMER
 * (and IG_TOTP_SECRET_INSTAGRAM_CUSTOMER if that account has two-factor). The username is
 * not a secret - it is the public handle already shown on the profile - and stays a plain
 * IG_USERNAME_INSTAGRAM_CUSTOMER in .env.
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
import { currentCodeForSecret } from '../lib/totp.js'
import { autoconsentScript } from '../lib/privacy.js'
import { readSecret, hasEncryptedSecret } from '../lib/secrets.js'
import { raiseWindow } from '../lib/foreground.js'
import { clearHandoffBanner, showHandoffBanner } from '../lib/emphasis.js'
import type { Page } from 'playwright-core'

interface SiteLogin {
  /** Where the login form is. */
  loginUrl: string
  /** A cookie that only exists once signed in - the fast, idempotent check. */
  sessionCookie: { name: string; domain: string }
  usernameSelector: string
  /** The form is sent with Enter from this field: submit buttons change shape and language. */
  passwordSelector: string
  /** Prefix for this site's per-profile .env variables, e.g. "IG" -> IG_USERNAME_<PROFILE>. */
  envPrefix: string
  /** Shown after a password is submitted, only if the site asks for it. */
  totpSelector?: string
  totpSubmitSelector?: string
  /** Prompts Instagram (and similar sites) show right after a fresh sign-in. */
  afterLogin?: Array<{ selector: string; action: 'click' | 'dismiss' }>
  /** Addresses of a sign-in still in progress, where the session cookie can already exist. */
  pendingUrl?: RegExp
}

const SITES: Record<string, SiteLogin> = {
  instagram: {
    loginUrl: 'https://www.instagram.com/accounts/login/',
    sessionCookie: { name: 'sessionid', domain: 'instagram.com' },
    usernameSelector: 'input[name="email"]',
    // "pass" since October 2026, "password" before.
    passwordSelector: 'input[name="pass"], input[name="password"]',
    envPrefix: 'IG',
    totpSelector: 'input[name="verificationCode"], input[aria-label*="ecurity code" i]',
    totpSubmitSelector: 'button[type="button"]:has-text("Confirm"), button:has-text("Weiter")',
    afterLogin: [
      {
        selector:
          'button:has-text("Not now"), button:has-text("Jetzt nicht"), ' +
          '[role="button"]:has-text("Not now"), [role="button"]:has-text("Jetzt nicht")',
        action: 'dismiss',
      },
    ],
  },
  // A Facebook account usually has two-factor without a shared secret (an app approval
  // or a code from another device), so a person finishes that step once - see
  // waitForPerson below. The session then lasts for months.
  facebook: {
    loginUrl: 'https://www.facebook.com/login/',
    sessionCookie: { name: 'c_user', domain: 'facebook.com' },
    usernameSelector: 'input[name="email"]',
    passwordSelector: 'input[name="pass"]',
    envPrefix: 'FB',
    pendingUrl: /checkpoint|two_step_verification|two_factor|\/login/,
  },
}

/** How long a person has to finish a security check the site shows after the password. */
const PERSON_TIMEOUT_MS = 10 * 60_000

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
  if (site.pendingUrl?.test(page.url())) return false
  return cookies.some(c => c.name === site.sessionCookie.name)
}

/** Reject cookie banners the same way a recording does, so they never block a field. */
async function rejectCookies(page: Page): Promise<void> {
  const script = autoconsentScript()
  if (script) await page.addInitScript(script).catch(() => {})
  await page.waitForTimeout(1500)
  const reject = page
    .locator(
      '[aria-label*="ablehnen" i], [aria-label*="ecline" i], [aria-label*="eject" i], ' +
        'button:has-text("Optionale Cookies ablehnen"), button:has-text("Decline optional cookies")',
    )
    .first()
  if (await reject.count().catch(() => 0)) {
    await reject.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(500)
  }
}

/**
 * The password went in, but the site still wants something only its owner can give - an
 * approval on the phone, a code from another device, a "was this you?". The window comes
 * to the front with the request across the top, and this waits for the session cookie.
 */
async function waitForPerson(page: Page, site: SiteLogin, out: (s: string) => void): Promise<void> {
  out(
    'The site is asking for a security check after the password. Finish it in the browser ' +
      `window that just came to the front (up to ${PERSON_TIMEOUT_MS / 60_000} minutes).`,
  )
  await raiseWindow((await page.title().catch(() => '')).slice(0, 30) || 'Chromium').catch(() => '')
  await showHandoffBanner(
    page,
    'Finish the sign-in here: approve it on your phone or type the code. This window closes by itself.',
  ).catch(() => {})
  const deadline = Date.now() + PERSON_TIMEOUT_MS
  while (!(await isSignedIn(page, site))) {
    if (Date.now() > deadline) {
      throw new Error(
        `No ${site.sessionCookie.name} cookie within ${PERSON_TIMEOUT_MS / 60_000} minutes: ` +
          'the password may be wrong, or the security check was not finished.',
      )
    }
    await page.waitForTimeout(2000)
  }
  await clearHandoffBanner(page).catch(() => {})
  // Let the site finish writing the rest of its session before the profile is closed.
  await page.waitForTimeout(3000)
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

  // Loads .env first: a username that is a public handle lives there. One that is a
  // private e-mail address or phone number goes through set-secret.ps1 like the password.
  const config = loadConfig()
  const username = readSecret(env.username)
  const password = readSecret(env.password)
  if (!username || !password) {
    out(
      `${env.username} must be set in .env (or with set-secret.ps1, if it is private), and ` +
        `${env.password} must be set once with:\n` +
        `  powershell -File scripts\\set-secret.ps1 -Name ${env.password}\n` +
        '(masked input, encrypted with Windows DPAPI - never typed into a file or a chat).',
    )
    process.exit(1)
  }
  out(
    hasEncryptedSecret(env.password)
      ? `Using the encrypted ${env.password}.`
      : `${env.password} is a plain .env value - move it to set-secret.ps1 when you can.`,
  )

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

    out(`Signing in to ${siteName}${hasEncryptedSecret(env.username) ? '' : ` as ${username}`}...`)
    await userField.click()
    await userField.pressSequentially(username, { delay: 40 })
    const passwordField = page.locator(site.passwordSelector).first()
    await passwordField.pressSequentially(password, { delay: 40 })
    await passwordField.press('Enter')

    // A two-factor prompt is optional: only handled if the site actually shows it.
    if (site.totpSelector) {
      const totpField = page.locator(site.totpSelector).first()
      try {
        await totpField.waitFor({ state: 'visible', timeout: 15_000 })
        const totpSecret = readSecret(env.totpSecret)
        if (!totpSecret) {
          throw new Error(
            `${siteName} is asking for a two-factor code, but no ${env.totpSecret} is ` +
              'configured to answer it (set it with set-secret.ps1, same as the password).',
          )
        }
        const code = await currentCodeForSecret(totpSecret)
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

    if (!(await isSignedIn(page, site))) await waitForPerson(page, site, out)
    out(`Signed in. Profile "${profile}" is ready for a recording.`)
  } finally {
    await context.close()
  }
}

main().catch(err => {
  process.stderr.write(`autologin failed: ${(err as Error).message}\n`)
  process.exit(1)
})
