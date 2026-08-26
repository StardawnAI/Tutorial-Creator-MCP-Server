#!/usr/bin/env node
/**
 * One-time sign-in for a tutorial browser profile.
 *
 * Opens a visible browser against the profile so you can log in by hand. The
 * session is written into the profile directory and every later headless recording
 * reuses it.
 *
 *   npm run login -- --url https://app.example.com
 *   npm run login -- --url https://app.example.com --profile work
 */

import path from 'node:path'
import readline from 'node:readline'
import { loadConfig } from '../lib/env.js'
import { launchBrowser } from '../lib/browser.js'

function parseArgs(argv: string[]): { url: string | null; profile: string } {
  let url: string | null = null
  let profile = 'default'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--url' || arg === '-u') && argv[i + 1]) url = argv[++i] ?? null
    else if ((arg === '--profile' || arg === '-p') && argv[i + 1]) profile = argv[++i] ?? 'default'
    else if (arg && !arg.startsWith('-') && !url) url = arg
  }
  return { url, profile }
}

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(prompt, () => {
      rl.close()
      resolve()
    })
  })
}

async function main(): Promise<void> {
  const config = loadConfig()
  const { url, profile } = parseArgs(process.argv.slice(2))

  const out = (s: string) => process.stdout.write(`${s}\n`)

  out(`Opening a browser for profile "${profile}".`)
  out(`Profile directory: ${path.join(config.paths.profiles, profile)}`)
  out('')

  const { context, page } = await launchBrowser(config, {
    profile,
    width: 1440,
    height: 900,
    headless: false,
    deviceScaleFactor: 1,
  })

  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {
      out(`Could not open ${url} - navigate there yourself in the window.`)
    })
  }

  out('Sign in to whatever sites you want to record, in the window that just opened.')
  out('You can visit several sites; every session is kept in this one profile.')
  out('')
  await waitForEnter('Press Enter here when you are done, to save and close... ')

  const pages = context.pages()
  const visited = pages.map(p => p.url()).filter(u => u && u !== 'about:blank')

  await context.close()

  out('')
  out(`Saved. Profile "${profile}" is ready.`)
  if (visited.length > 0) out(`Last open: ${visited.join(', ')}`)
  out(`Record with: tutorial_start({ title: "...", profile: "${profile}" })`)
}

main().catch(err => {
  process.stderr.write(`login failed: ${(err as Error).message}\n`)
  process.exit(1)
})
