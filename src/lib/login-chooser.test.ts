import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { chromium, type Browser } from 'playwright-core'
import { loadConfig } from './env.js'
import { OTHER_PROFILE, leaveAccountChooser } from './login-chooser.js'

const FORM = 'input[name="email"]'

/** The chooser as measured on instagram.com on 2026-11-04: role=button divs, the form only after "another profile". */
const chooser = (other: string): string => `
  <div role="button" id="c1" onclick="window.continued = (window.continued || 0) + 1">Continue</div>
  <div role="button" id="c2" onclick="window.continued = (window.continued || 0) + 1">Continue</div>
  <div role="button" id="o" onclick="setTimeout(() => { document.body.innerHTML = '<input name=email><input name=pass>' }, 300)">${other}</div>
  <div role="button">Remove profiles from this browser</div>`

const chromiumPath = loadConfig().chromiumPath
const skip = !chromiumPath || !fs.existsSync(chromiumPath) ? 'no Chromium on this computer' : false

test('the other-profile label is matched in English and German, and nothing else', () => {
  for (const label of ['Use another profile', 'Anderes Profil verwenden', 'Switch accounts', 'Konto wechseln']) {
    assert.ok(OTHER_PROFILE.test(label), label)
  }
  for (const label of ['Continue', 'Remove profiles from this browser', 'Log in', 'Create new account']) {
    assert.ok(!OTHER_PROFILE.test(label), label)
  }
})

test('the chooser is left through "another profile", never through "Continue"', { skip }, async () => {
  const browser: Browser = await chromium.launch({ executablePath: chromiumPath!, headless: true })
  try {
    for (const label of ['Use another profile', 'Anderes Profil verwenden']) {
      const page = await browser.newPage()
      await page.setContent(chooser(label))
      assert.equal(await leaveAccountChooser(page, FORM, 4000), true)
      assert.equal(await page.locator(FORM).count(), 1)
      assert.equal(await page.evaluate(() => (window as unknown as { continued?: number }).continued ?? 0), 0)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})

test('a page that already shows the form is left alone', { skip }, async () => {
  const browser: Browser = await chromium.launch({ executablePath: chromiumPath!, headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<input name="email"><input name="pass"><div role="button">Use another profile</div>')
    assert.equal(await leaveAccountChooser(page, FORM, 4000), false)
  } finally {
    await browser.close()
  }
})

test('neither form nor chooser ends after the wait, without pressing anything', { skip }, async () => {
  const browser: Browser = await chromium.launch({ executablePath: chromiumPath!, headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div role="button">Continue</div>')
    assert.equal(await leaveAccountChooser(page, FORM, 1200), false)
  } finally {
    await browser.close()
  }
})
