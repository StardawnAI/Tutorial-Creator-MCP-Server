#!/usr/bin/env node
/**
 * Sign the server in to HeyGen as the account's owner.
 *
 *   npm run heygen-login
 *
 * With HEYGEN_EMAIL and HEYGEN_PASSWORD set this runs unattended, exactly as the
 * server does when it needs a sign-in. Without them it opens the server's own
 * browser window and waits for a person to sign in there, once; the window's
 * profile keeps that session, so every later consent is made without anybody.
 * Either way renders and speech are then billed to the web subscription's credits
 * rather than to the API wallet - see src/lib/heygen-auth.ts.
 */

import { loadConfig } from '../lib/env.js'
import { heygenLoginFile, signInToHeyGen } from '../lib/heygen-auth.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const byHand = !config.heygenLogin

  process.stdout.write(
    byHand
      ? 'A browser window opens on HeyGen. Sign in there with the account that owns the ' +
          'avatar; access is granted by itself once you are in.\n'
      : 'Signing in to HeyGen with HEYGEN_EMAIL and HEYGEN_PASSWORD...\n',
  )
  await signInToHeyGen(config, { waitForPerson: byHand })
  process.stdout.write(`Signed in. The sign-in is kept in ${heygenLoginFile(config)}.\n`)
}

main().catch(err => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
