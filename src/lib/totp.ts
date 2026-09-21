/**
 * Two-factor codes from an authenticator secret (RFC 6238, the scheme behind Google
 * Authenticator, 1Password and the rest).
 *
 * This is what makes two-factor a non-issue for a recording: the six digits are a
 * function of a shared secret and the clock, so a site that offers "use an
 * authenticator app" can be signed into without a person. A code sent by SMS or
 * e-mail is a different matter - nothing here can read those.
 *
 * The secret never travels through a tool call. It is read from the environment by
 * the name the caller gives, so it stays out of the conversation and out of the logs.
 */

import crypto from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode a secret the way an authenticator app prints it: base32, spaced, any case. */
export function decodeBase32(secret: string): Buffer {
  const cleaned = secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!/^[A-Z2-7]+$/.test(cleaned)) {
    throw new Error('That does not look like an authenticator secret (expected base32).')
  }

  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of cleaned) {
    value = (value << 5) | BASE32.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** The code valid at `atMs`. */
export function totp(
  secret: string,
  options: { atMs?: number; stepSeconds?: number; digits?: number } = {},
): string {
  const step = options.stepSeconds ?? 30
  const digits = options.digits ?? 6
  const counter = Math.floor((options.atMs ?? Date.now()) / 1000 / step)

  const message = Buffer.alloc(8)
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  message.writeUInt32BE(counter >>> 0, 4)

  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(message).digest()
  // Dynamic truncation: the low nibble of the last byte picks four bytes to use.
  const offset = (digest[digest.length - 1] as number) & 0x0f
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff)

  return String(binary % 10 ** digits).padStart(digits, '0')
}

/** How long the current code is still valid, in seconds. */
export function secondsLeft(atMs: number = Date.now(), stepSeconds = 30): number {
  return stepSeconds - Math.floor(atMs / 1000) % stepSeconds
}

/**
 * The current code for the secret held in an environment variable.
 *
 * A code with two seconds left on it is typed, submitted and rejected, which in a
 * recording looks like the tutorial not working - so the next one is waited for.
 */
export async function currentCode(variable: string): Promise<string> {
  const secret = process.env[variable]
  if (!secret) {
    throw new Error(
      `No two-factor secret in the environment variable ${variable}. Set it to the base32 ` +
        'secret the site showed when two-factor was switched on.',
    )
  }
  if (secondsLeft() < 5) {
    await new Promise(resolve => setTimeout(resolve, (secondsLeft() + 1) * 1000))
  }
  return totp(secret)
}
