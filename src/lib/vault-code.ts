/**
 * Two-factor codes from the AWG vault, for an account whose authenticator key lives there.
 *
 * The key never reaches this tool. The person puts it on the account's entry in the
 * Bitwarden vault (collection "AWG Automation") once; AWG's hub computes the current
 * six digits and releases them to this computer for one page - the same release the agents'
 * browser uses (AWG's lib/vault-signin.mjs). The hub checks that the page is the entry's own
 * site, applies the entry's rule (an "ask" entry waits for the person's Allow on Telegram) and
 * logs the release without the value. A local IG_TOTP_SECRET_<PROFILE> still wins where one
 * exists; this is only the way when none does.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Where AWG's tools live on this computer; AWG_TOOLS_DIR overrides it. */
const DEFAULT_AWG_TOOLS = 'C:\\AWG\\Github\\StardawnAI\\AI-Working-Ground\\awg-tools'

/** One vault entry as the hub lists it: never a value. */
export interface VaultEntry {
  name: string
  account?: string
  site?: string
  sites?: string[]
  kinds?: string[]
}

export type VaultRelease = { status: string; value?: string; message?: string }

/** The part of AWG's vaultSignin() this needs. */
export interface VaultClient {
  entries(): Promise<VaultEntry[]>
  release(args: { entry: VaultEntry; kind: 'totp'; origin: string; reason: string }): Promise<VaultRelease>
}

const sameSite = (entry: VaultEntry, host: string): boolean =>
  (entry.sites ?? [entry.site]).some(s => !!s && (s === host || s.endsWith(`.${host}`) || host.endsWith(`.${s}`)))

/** The one entry of `account` on `host` that holds an authenticator key, or why there is none. */
export function pickTotpEntry(
  entries: VaultEntry[],
  host: string,
  account: string,
): { entry: VaultEntry } | { error: string } {
  const mine = entries.filter(
    e => sameSite(e, host) && (e.account ?? '').trim().toLowerCase() === account.trim().toLowerCase(),
  )
  if (mine.length === 0) {
    return {
      error:
        `The AWG vault has no entry for ${account} on ${host}. Save the login in the Bitwarden ` +
        'vault, in the collection "AWG Automation".',
    }
  }
  const withKey = mine.filter(e => (e.kinds ?? []).includes('totp'))
  if (withKey.length === 0) {
    return {
      error:
        `The vault entry "${mine[0]!.name}" holds no authenticator key yet. Open it in the Bitwarden ` +
        'vault, press Edit, paste the key into "Authenticator key (TOTP)" and save; the hub sees it ' +
        'within about two minutes.',
    }
  }
  if (withKey.length > 1) {
    return {
      error:
        `${withKey.length} vault entries for ${account} on ${host} hold an authenticator key ` +
        `(${withKey.map(e => `"${e.name}"`).join(', ')}); keep only one.`,
    }
  }
  return { entry: withKey[0]! }
}

/** AWG's own vault client, loaded from its tools folder. */
async function awgClient(): Promise<VaultClient> {
  const dir = process.env.AWG_TOOLS_DIR || DEFAULT_AWG_TOOLS
  const file = path.join(dir, 'lib', 'vault-signin.mjs')
  if (!fs.existsSync(file)) {
    throw new Error(`AWG's vault client was not found at ${file}. Set AWG_TOOLS_DIR to AWG's awg-tools folder.`)
  }
  const mod = (await import(pathToFileURL(file).href)) as { vaultSignin: () => VaultClient }
  return mod.vaultSignin()
}

/** How often a code is asked for while the hub waits for the person's Allow; each call holds ~45 s. */
const MAX_PENDING_ROUNDS = 6

/**
 * The current code for `account` on `host`. `origin` is the page the code is typed on.
 * Throws a sentence a person can act on; the code itself is never logged.
 */
export async function codeFromVault(
  args: { host: string; account: string; origin: string; reason: string },
  client?: VaultClient,
): Promise<string> {
  const vault = client ?? (await awgClient())
  let entries: VaultEntry[]
  try {
    entries = await vault.entries()
  } catch (err) {
    throw new Error(`The AWG vault could not be reached: ${(err as Error).message}`)
  }
  const picked = pickTotpEntry(entries, args.host, args.account)
  if ('error' in picked) throw new Error(picked.error)

  for (let round = 1; round <= MAX_PENDING_ROUNDS; round++) {
    const answer = await vault.release({ entry: picked.entry, kind: 'totp', origin: args.origin, reason: args.reason })
    if (answer.status === 'released') {
      if (!answer.value || !/^\d{6,8}$/.test(answer.value)) throw new Error('The vault released something that is not a code.')
      return answer.value
    }
    if (answer.status !== 'pending') {
      throw new Error(`The vault did not release the code for "${picked.entry.name}" (${answer.status}): ${answer.message ?? 'no reason given'}`)
    }
  }
  throw new Error(`The code for "${picked.entry.name}" waits for the Allow on Telegram; nobody pressed it in time.`)
}
