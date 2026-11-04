/**
 * What stops an unattended sign-in from locking a real account.
 *
 * On 2026-11-03 Instagram locked Jim's real account `jpresting` for security and made him
 * set a new password. Automated sign-ins (this tool's autologin, run before every
 * recording) are the suspect: a stale password retried on every run, runs started in
 * parallel, and no word to the owner. Instagram, Facebook and similar sites treat repeated
 * or failing logins as an attack, so the rules here are strict:
 *
 *  - a session that is still signed in is reused and never logged in again (autologin
 *    checks that first, before this guard is asked);
 *  - ONE attempt per account. When it fails or ends in a security check nobody finished,
 *    no further attempt is made with the same password. The block lifts by itself when
 *    the stored password file is newer than that attempt (the owner changed it with
 *    set-secret.ps1);
 *  - never two sign-ins to one account at once, and none within MIN_GAP_MS of the last one;
 *  - a real account of a person needs that person's word first (`--approved`).
 *
 * The decision is a pure function so it can be tested; the ledger and the lock are small
 * files under profiles/ (gitignored, never committed).
 */

import fs from 'node:fs'
import path from 'node:path'
import { PROJECT_ROOT } from './env.js'

export type AttemptResult = 'started' | 'signed-in' | 'failed' | 'checkpoint'

export interface Attempt {
  /** ISO time the attempt started or ended. */
  at: string
  result: AttemptResult
}

export type Ledger = Record<string, Attempt>

/** A fresh sign-in this soon after the previous one means the session did not stick: do not repeat it. */
export const MIN_GAP_MS = 30 * 60_000
/** A run that started and never reported back is taken for a crash after this long. */
export const RUNNING_MS = 15 * 60_000

export type Verdict =
  | { ok: true }
  | { ok: false; code: 'needs-person' | 'already-running' | 'blocked-after-failure' | 'too-soon'; message: string }

export interface GuardInput {
  now: number
  last: Attempt | undefined
  /** When the stored password was last changed (file time of its .dpapi file); 0 when unknown. */
  secretAt: number
  /** A real account of a person, not a test account. */
  real: boolean
  /** The person said yes to this sign-in. */
  approved: boolean
  account: string
  minGapMs?: number
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

export function decide(i: GuardInput): Verdict {
  const at = i.last ? Date.parse(i.last.at) : NaN
  const age = Number.isFinite(at) ? i.now - at : Infinity

  if (i.real && !i.approved) {
    return {
      ok: false,
      code: 'needs-person',
      message:
        `${i.account} is a real account of the person. Tell them first - what goes out (a sign-in ` +
        'to the site as this account, from this computer) and why - and run again with --approved ' +
        'once they have said yes.',
    }
  }
  if (i.last && i.secretAt > at) return { ok: true } // the password is new since the last attempt: a first try with it
  if (i.last?.result === 'started' && age < RUNNING_MS) {
    return { ok: false, code: 'already-running', message: `A sign-in to ${i.account} is already running (started ${minutes(age)} min ago). Not starting a second one.` }
  }
  if (i.last && (i.last.result === 'failed' || i.last.result === 'checkpoint')) {
    return {
      ok: false,
      code: 'blocked-after-failure',
      message:
        `The last sign-in to ${i.account} ended in "${i.last.result}" (${i.last.at}). Trying again with the same ` +
        'password is how an account gets locked, so this stops here. Tell the person; once the password is ' +
        'changed with set-secret.ps1 (or the security check is finished by hand) the block lifts by itself.',
    }
  }
  if (i.last && age < (i.minGapMs ?? MIN_GAP_MS)) {
    return {
      ok: false,
      code: 'too-soon',
      message:
        `${i.account} was signed in ${minutes(age)} min ago and the session is gone again. A second fresh login so soon ` +
        `looks like an attack to the site. Not repeating it; try again after ${minutes((i.minGapMs ?? MIN_GAP_MS) - age)} min.`,
    }
  }
  return { ok: true }
}

export const accountKey = (site: string, username: string): string => `${site}:${username.trim().toLowerCase()}`

const dir = (): string => path.join(PROJECT_ROOT, 'profiles')
const ledgerFile = (): string => path.join(dir(), 'login-ledger.json')
const lockFile = (key: string): string => path.join(dir(), 'login-locks', `${key.replace(/[^a-z0-9]+/gi, '_')}.lock`)

export function readLedger(file = ledgerFile()): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Ledger) : {}
  } catch {
    return {}
  }
}

export function record(key: string, result: AttemptResult, now = Date.now(), file = ledgerFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const ledger = readLedger(file)
  ledger[key] = { at: new Date(now).toISOString(), result }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2))
  fs.renameSync(tmp, file)
}

/** Takes the account's lock; false when another run holds it (a lock older than RUNNING_MS is a crash and is taken over). */
export function acquire(key: string, now = Date.now()): boolean {
  const file = lockFile(key)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, String(now), { flag: 'wx' })
    return true
  } catch {
    const held = Number(fs.readFileSync(file, 'utf8'))
    if (Number.isFinite(held) && now - held < RUNNING_MS) return false
    fs.writeFileSync(file, String(now))
    return true
  }
}

export function release(key: string): void {
  fs.rmSync(lockFile(key), { force: true })
}

/** File time of a stored secret (when the password was last set), 0 when it is not a .dpapi file. */
export function secretChangedAt(name: string): number {
  try {
    return fs.statSync(path.join(PROJECT_ROOT, 'profiles', 'secrets', `${name}.dpapi`)).mtimeMs
  } catch {
    return 0
  }
}

/** A person-like pause: `min` to `max` milliseconds. */
export const pause = (min: number, max: number): number => Math.round(min + Math.random() * (max - min))
