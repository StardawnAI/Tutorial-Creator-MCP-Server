/**
 * Signing in to HeyGen as the account's owner, instead of with an API key.
 *
 * HeyGen bills the two differently, and the difference decides whether anything can
 * be rendered at all. An API key draws on a separate API wallet; an OAuth sign-in -
 * the route HeyGen's own MCP server and CLI use - draws on the credits of the web
 * subscription. On this account the API wallet stood at $0 while the subscription
 * held over a thousand credits, so every render with the key was refused.
 *
 * The flow is plain OAuth 2 with PKCE against HeyGen's authorization server, which
 * accepts dynamic client registration and a loopback redirect. The consent page is
 * answered by the server's own browser, in a profile that keeps HeyGen's web session
 * the way the recording profiles keep other logins: it signs in there by itself
 * from HEYGEN_EMAIL and HEYGEN_PASSWORD (and HEYGEN_TOTP_SECRET), or a person signs
 * in there once through `npm run heygen-login`. Between consents the refresh token
 * keeps the sign-in alive; when HeyGen stops honouring it, the browser consents
 * again. The tokens are kept in `profiles/` and never leave the machine.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { Locator, Page } from 'playwright-core'
import { launchBrowser } from './browser.js'
import type { Config } from './env.js'
import { log } from './logger.js'
import { currentCode } from './totp.js'

const AUTH_SERVER = 'https://api2.heygen.com'
const PORT = 47832
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`
const SCOPE = 'openid profile email'
/** The browser profile, under `profiles/`, that holds HeyGen's web session. */
const HEYGEN_PROFILE = 'heygen'

interface StoredLogin {
  clientId: string
  accessToken: string
  refreshToken: string | null
  /** Epoch milliseconds after which the access token must be refreshed. */
  expiresAt: number
  obtainedAt: string
}

export function heygenLoginFile(config: Config): string {
  return path.join(config.paths.profiles, 'heygen-oauth.json')
}

export function hasHeyGenLogin(config: Config): boolean {
  return fs.existsSync(heygenLoginFile(config))
}

/** Whether HeyGen can be used as the account's owner: signed in, or able to sign in unattended. */
export function canSignInToHeyGen(config: Config): boolean {
  return hasHeyGenLogin(config) || Boolean(config.heygenLogin)
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function post(url: string, body: URLSearchParams | object): Promise<{ status: number; body: any }> {
  const form = body instanceof URLSearchParams
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? body.toString() : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      let parsed: any = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { raw: text.slice(0, 300) }
      }
      return { status: response.status, body: parsed }
    } catch (err) {
      lastError = err as Error
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
    }
  }
  throw new Error(`HeyGen's sign-in server could not be reached: ${lastError?.message}`)
}

function save(config: Config, login: StoredLogin): void {
  fs.mkdirSync(path.dirname(heygenLoginFile(config)), { recursive: true })
  fs.writeFileSync(heygenLoginFile(config), JSON.stringify(login, null, 2))
}

function fromTokenResponse(clientId: string, body: any, previousRefresh: string | null): StoredLogin {
  const lifetime = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600
  return {
    clientId,
    accessToken: String(body.access_token),
    // A refresh response may or may not rotate the refresh token.
    refreshToken: body.refresh_token ? String(body.refresh_token) : previousRefresh,
    expiresAt: Date.now() + lifetime * 1000,
    obtainedAt: new Date().toISOString(),
  }
}

/**
 * Begin a sign-in: register this server as a client, start listening for the
 * redirect, and hand back the address the person has to open.
 *
 * `done` settles when "allow" has been clicked and the tokens are stored, after
 * `timeoutMs` if nobody does, or when `cancel` is called.
 */
export async function startHeyGenLogin(
  config: Config,
  timeoutMs = 30 * 60_000,
): Promise<{ url: string; done: Promise<void>; cancel: (reason: string) => void }> {
  const registration = await post(`${AUTH_SERVER}/v1/oauth/register`, {
    client_name: 'Stardawn Tutorial Creator',
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
  })
  const clientId = registration.body?.client_id
  if (registration.status >= 300 || !clientId) {
    throw new Error(`HeyGen refused to register this server (HTTP ${registration.status}).`)
  }

  const verifier = base64url(crypto.randomBytes(48))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  const state = base64url(crypto.randomBytes(24))

  const url =
    `${AUTH_SERVER}/v1/oauth/authorize?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // No `resource`: naming HeyGen's MCP server would scope the token to that server,
      // while it is spent on api.heygen.com - which HeyGen's own CLI, signed in the same
      // way, calls with its token and nothing else.
    }).toString()

  let cancel: (reason: string) => void = () => {}
  const done = new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const requested = new URL(req.url ?? '/', REDIRECT_URI)
      if (requested.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const finish = (status: number, message: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          `<!doctype html><title>Tutorial Creator</title><body style="font:18px system-ui;` +
            `padding:48px;max-width:640px">${message}</body>`,
        )
      }

      if (requested.searchParams.get('state') !== state) {
        finish(400, 'This sign-in link is stale. Start it again from the Tutorial Creator.')
        return
      }
      const code = requested.searchParams.get('code')
      if (!code) {
        const why = requested.searchParams.get('error_description') ?? requested.searchParams.get('error')
        finish(400, `HeyGen did not grant access${why ? `: ${why}` : ''}.`)
        cleanup()
        reject(new Error(`HeyGen did not grant access${why ? `: ${why}` : ''}`))
        return
      }

      try {
        const token = await post(
          `${AUTH_SERVER}/v1/oauth/token`,
          new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
          }),
        )
        if (token.status >= 300 || !token.body?.access_token) {
          throw new Error(`the token exchange failed (HTTP ${token.status})`)
        }
        save(config, fromTokenResponse(clientId, token.body, null))
        finish(200, 'Signed in to HeyGen. You can close this tab.')
        cleanup()
        resolve()
      } catch (err) {
        finish(500, `Signing in failed: ${(err as Error).message}`)
        cleanup()
        reject(err as Error)
      }
    })

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Nobody completed the HeyGen sign-in in time.'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      server.close()
    }
    cancel = reason => {
      cleanup()
      reject(new Error(reason))
    }
    server.on('error', err => {
      cleanup()
      reject(new Error(`Could not listen on port ${PORT} for the sign-in: ${err.message}`))
    })
    server.listen(PORT, '127.0.0.1')
  })

  return { url, done, cancel: reason => cancel(reason) }
}

/**
 * Whether an element is really in front of the viewer. HeyGen keeps every step of
 * its sign-in - email, password, the two-factor code - in the page at once and
 * slides between them, so "visible" to Playwright is true of steps nobody can see.
 */
async function showing(locator: Locator): Promise<boolean> {
  const first = locator.first()
  if (!(await first.isVisible().catch(() => false))) return false
  return first
    .evaluate(el => {
      const box = el.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return hit !== null && (hit === el || el.contains(hit) || hit.contains(el))
    })
    .catch(() => false)
}

/** The button on HeyGen's consent page that grants access. */
const CONSENT = /^(allow|authorize|approve|accept|grant|continue|confirm|agree)\b/i

/**
 * Take HeyGen's authorize page to the redirect: sign in if the profile is signed
 * out, answer a two-factor prompt, and grant access.
 *
 * Returns when the redirect is under way; `finished` reports that the tokens are in.
 * Without credentials a signed-out page is either waited on, when a person is at the
 * window, or given up on.
 */
async function driveConsent(
  config: Config,
  page: Page,
  url: string,
  finished: () => boolean,
  waitForPerson: boolean,
): Promise<void> {
  const deadline = Date.now() + (waitForPerson ? 30 : 2) * 60_000
  const creds = config.heygenLogin
  let logins = 0
  let lastCode = ''

  while (!finished()) {
    if (Date.now() > deadline) {
      throw new Error('HeyGen never got as far as granting access.')
    }
    await page.waitForTimeout(1500)
    if (page.url().startsWith(REDIRECT_URI)) continue

    const code = page.getByPlaceholder(/6-digit code/i)
    const password = page.getByPlaceholder(/enter password/i)
    const email = page.getByPlaceholder(/enter your email/i)
    const useEmail = page.getByRole('button', { name: /^use email$/i })
    const signedOut =
      (await showing(code)) || (await showing(password)) || (await showing(email)) || (await showing(useEmail))

    if (signedOut) {
      if (!creds) {
        if (waitForPerson) continue
        throw new Error(
          "HeyGen is not signed in in the server's browser, and HEYGEN_EMAIL and HEYGEN_PASSWORD " +
            'are not set. Set them, or sign in once with `npm run heygen-login`.',
        )
      }
      if (await showing(code)) {
        if (!process.env.HEYGEN_TOTP_SECRET) {
          if (waitForPerson) continue
          throw new Error('HeyGen asks for a two-factor code, and HEYGEN_TOTP_SECRET is not set.')
        }
        const next = await currentCode('HEYGEN_TOTP_SECRET')
        if (next === lastCode) continue // rejected once already; wait for the next one
        lastCode = next
        await code.first().fill(next)
        await page.getByRole('button', { name: /^verify$/i }).first().click()
      } else if (await showing(password)) {
        if (++logins > 2) {
          // The reason comes as a toast ("Invalid username/password") above a page of labels.
          const text = await page.locator('body').innerText().catch(() => '')
          const said = text.split('\n').find(line => /invalid|incorrect|wrong|locked|too many|not found/i.test(line))
          throw new Error(
            `HeyGen did not accept HEYGEN_EMAIL and HEYGEN_PASSWORD${said ? `: "${said.trim()}"` : ''}.`,
          )
        }
        if (await showing(email)) await email.first().fill(creds.email)
        await password.first().fill(creds.password)
        await page.getByRole('button', { name: /^log in$/i }).first().click()
      } else if (await showing(email)) {
        await email.first().fill(creds.email)
        await page.getByRole('button', { name: /^use password$/i }).first().click()
      } else {
        await useEmail.first().click()
      }
      continue
    }

    // Signed in. A sign-in can land on the app's home page rather than back here.
    if (!page.url().includes('/oauth/authorize')) {
      await page.goto(url)
      continue
    }
    const grant = page.getByRole('button', { name: CONSENT })
    if (await showing(grant)) await grant.first().click()
  }
}

/**
 * Sign in to HeyGen with the server's own browser, as the account's owner.
 *
 * Headless and unattended by default: the profile's web session, or failing that
 * HEYGEN_EMAIL and HEYGEN_PASSWORD, gets through the sign-in, and the consent is
 * clicked. `waitForPerson` shows the window and waits for someone to sign in by
 * hand - once, after which the profile remembers it.
 */
export async function signInToHeyGen(
  config: Config,
  options: { headless?: boolean; waitForPerson?: boolean } = {},
): Promise<void> {
  const waitForPerson = options.waitForPerson ?? false
  const { url, done, cancel } = await startHeyGenLogin(config, (waitForPerson ? 30 : 3) * 60_000)
  let finished = false
  done.then(
    () => (finished = true),
    () => (finished = true),
  )

  const browser = await launchBrowser(config, {
    profile: HEYGEN_PROFILE,
    width: 1280,
    height: 860,
    headless: options.headless ?? !waitForPerson,
    locale: 'en-US',
  })
  try {
    await browser.page.goto(url)
    await Promise.race([done, driveConsent(config, browser.page, url, () => finished, waitForPerson)])
    await done
  } catch (err) {
    const shot = path.join(config.paths.profiles, 'heygen-sign-in-failed.png')
    await browser.page.screenshot({ path: shot }).catch(() => {})
    cancel((err as Error).message)
    throw new Error(`Signing in to HeyGen failed: ${(err as Error).message} (screenshot: ${shot})`)
  } finally {
    await browser.context.close().catch(() => {})
  }
}

function readLogin(config: Config): StoredLogin {
  return JSON.parse(fs.readFileSync(heygenLoginFile(config), 'utf8')) as StoredLogin
}

async function currentToken(config: Config): Promise<string | null> {
  if (!hasHeyGenLogin(config)) {
    if (!config.heygenLogin) return null
    log.info('Signing in to HeyGen')
    await signInToHeyGen(config)
    return readLogin(config).accessToken
  }

  const login = readLogin(config)
  if (Date.now() < login.expiresAt - 60_000) return login.accessToken

  if (login.refreshToken) {
    const token = await post(
      `${AUTH_SERVER}/v1/oauth/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: login.refreshToken,
        client_id: login.clientId,
      }),
    )
    if (token.status < 300 && token.body?.access_token) {
      const renewed = fromTokenResponse(login.clientId, token.body, login.refreshToken)
      save(config, renewed)
      log.info('HeyGen sign-in renewed')
      return renewed.accessToken
    }
    log.warn(`HeyGen would not renew the sign-in (HTTP ${token.status}); consenting again`)
  }

  // No refresh token, or one HeyGen no longer honours: consent again, as a person would.
  await signInToHeyGen(config)
  return readLogin(config).accessToken
}

let inFlight: Promise<string | null> | null = null

/**
 * A current access token - renewed, or signed in afresh, as needed - or null when
 * there is no sign-in and none can be made.
 *
 * Avatar clips are rendered several at a time, and each asks for a token; they
 * share one renewal rather than racing to rotate the same refresh token.
 */
export function heygenAccessToken(config: Config): Promise<string | null> {
  inFlight ??= currentToken(config).finally(() => {
    inFlight = null
  })
  return inFlight
}
