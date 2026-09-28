/**
 * Reading a credential without it ever sitting in a plain-text file.
 *
 * `set-secret.ps1` is run by a person, in their own PowerShell window: the value they type
 * is masked, never sent anywhere, and immediately encrypted with Windows' own DPAPI - bound
 * to that Windows account on that machine, useless if the file is copied anywhere else.
 * This reads it back the same way: it shells out to `read-secret.ps1`, which decrypts and
 * prints the plain value on its own line, captured here and nowhere else - never logged,
 * never written back to disk.
 *
 * A name with no encrypted file yet falls back to a plain environment variable of the same
 * name (still read from .env, same as before this existed), so nothing breaks for a secret
 * that has not been moved over. Prefer the encrypted path for anything that unlocks a real
 * account - `set-secret.ps1` in the README explains why the two are not equivalent.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PROJECT_ROOT } from './env.js'

/**
 * `name`, decrypted from `profiles/secrets/<name>.dpapi` if that file exists, otherwise
 * `process.env[name]`, otherwise null.
 */
export function readSecret(name: string): string | null {
  const encrypted = path.join(PROJECT_ROOT, 'profiles', 'secrets', `${name}.dpapi`)
  if (fs.existsSync(encrypted)) {
    const script = path.join(PROJECT_ROOT, 'scripts', 'read-secret.ps1')
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', encrypted],
      { encoding: 'utf8' },
    )
    if (result.status !== 0) {
      throw new Error(
        `Could not decrypt ${encrypted}: ${result.stderr?.trim() || `PowerShell exited ${result.status}`}`,
      )
    }
    const value = result.stdout.replace(/\r?\n$/, '')
    return value.length > 0 ? value : null
  }
  return process.env[name] ?? null
}

/** Whether `name` has an encrypted entry - used to tell a caller how the value got here. */
export function hasEncryptedSecret(name: string): boolean {
  return fs.existsSync(path.join(PROJECT_ROOT, 'profiles', 'secrets', `${name}.dpapi`))
}
