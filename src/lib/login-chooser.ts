/**
 * Instagram's account chooser.
 *
 * A browser profile that was signed in once and signed out again is greeted by
 * "Continue as <name> / Use another profile" instead of the username and password form.
 * Measured 2026-11-04 on a profile that still remembers jpresting: the entries are
 * `div[role=button]` ("Continue" once per remembered account, "Use another profile",
 * "Remove profiles from this browser"), and the form fields only appear after
 * "Use another profile". This presses that button so the ordinary form path runs unchanged.
 * "Continue" is never pressed: it would sign in as whichever account the browser remembers.
 */

import type { Page } from 'playwright-core'

/** The chooser's "another account" entry, English and German. */
export const OTHER_PROFILE =
  /^\s*(use another profile|use another account|switch accounts?|log into another account|anderes profil verwenden|anderes konto verwenden|konto wechseln|zu einem anderen konto wechseln|bei einem anderen konto anmelden)\s*$/i

/**
 * Waits up to `waitMs` for the login form or the chooser. If the chooser comes, presses
 * "Use another profile" and waits for the form. True when the chooser was there.
 */
export async function leaveAccountChooser(page: Page, formSelector: string, waitMs = 8000): Promise<boolean> {
  const form = page.locator(formSelector).first()
  const other = page.locator('button, a, [role="button"], [role="link"]').filter({ hasText: OTHER_PROFILE }).first()
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (await form.isVisible().catch(() => false)) return false
    if (await other.isVisible().catch(() => false)) {
      await other.click({ timeout: 5000 }).catch(() => {
        throw new Error('The sign-in page shows an account chooser, but "Use another profile" could not be pressed (a banner may cover it).')
      })
      await form.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      return true
    }
    await page.waitForTimeout(400)
  }
  return false
}
