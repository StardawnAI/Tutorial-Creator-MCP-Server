/**
 * Cookie banners and private content on real sites, with and without the privacy layer.
 *
 * Each site is opened twice in an empty throwaway profile - once as it is, once with
 * the layer - and both are photographed side by side, so what changed can be looked
 * at rather than assumed. Needs the network; not part of e2e.mjs for that reason.
 *
 *   node scripts/privacy-live.mjs [outdir] [url ...]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../dist/lib/env.js'
import { launchBrowser } from '../dist/lib/browser.js'
import { Privacy, describePrivacy } from '../dist/lib/privacy.js'
import { run } from '../dist/lib/ffmpeg.js'

const DEFAULT_SITES = [
  'https://www.instagram.com/instagram/',
  'https://www.facebook.com/',
  'https://www.youtube.com/',
  'https://www.spiegel.de/',
  'https://www.cookiebot.com/',
  'https://www.zeit.de/',
  'https://www.linkedin.com/',
  'https://www.bahn.de/',
]

const config = loadConfig()
const outDir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-live-'))
const sites = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_SITES
fs.mkdirSync(outDir, { recursive: true })

async function visit(url, withPrivacy, file) {
  const launched = await launchBrowser(config, {
    profile: 'privacy-live',
    fresh: true,
    width: 1280,
    height: 800,
    headless: true,
    locale: 'de-DE',
  })
  try {
    const privacy = withPrivacy
      ? await Privacy.install(launched.context, config, { cookies: true, veil: true })
      : null
    const started = Date.now()
    let settled = 0
    await launched.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    await launched.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {})
    await launched.page.waitForTimeout(800)
    if (privacy) {
      // Exactly what a recording does before its first frame, and then the picture: if
      // a banner or its aftermath is still on screen here, it would be in the video.
      const settleFrom = Date.now()
      await privacy.settle(launched.page, { graceMs: 2000 })
      settled = Date.now() - settleFrom
    } else {
      // Long enough for a banner to show up.
      await launched.page.waitForTimeout(4000)
    }
    const took = Date.now() - started
    await launched.page.screenshot({ path: file }).catch(() => {})
    return privacy
      ? `${describePrivacy(await privacy.report(launched.page))}\n(ready after ${(took / 1000).toFixed(1)}s, of which ${(settled / 1000).toFixed(1)}s waiting for the banner)`
      : ''
  } finally {
    await launched.context.close().catch(() => {})
    if (launched.disposableDir) fs.rmSync(launched.disposableDir, { recursive: true, force: true })
  }
}

for (const [i, url] of sites.entries()) {
  const name = `${String(i).padStart(2, '0')}-${new URL(url).hostname.replace(/^www\./, '')}`
  const plain = path.join(outDir, `${name}-plain.png`)
  const veiled = path.join(outDir, `${name}-privacy.png`)
  try {
    await visit(url, false, plain)
    const report = await visit(url, true, veiled)
    process.stdout.write(`\n${url}\n  ${report.split('\n').join('\n  ')}\n`)
    await run(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', plain, '-i', veiled,
      '-filter_complex', '[0]scale=640:-2[a];[1]scale=640:-2[b];[a][b]hstack',
      path.join(outDir, `${name}-pair.png`),
    ])
  } catch (err) {
    process.stdout.write(`\n${url}\n  FAILED: ${err.message.split('\n')[0]}\n`)
  }
}
process.stdout.write(`\nPictures: ${outDir}\n`)
