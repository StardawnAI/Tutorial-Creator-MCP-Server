/**
 * What the camera has to keep in view, and when the scene under it has changed.
 *
 * The camera holds its framing while the next action lands inside it - pulling out and
 * pushing back in for every click in one corner is seasickness. But "the next button is
 * in frame" is not the same as "what the viewer needs is in frame". Two cases broke it
 * in a real recording:
 *
 * - A confirmation opened in the middle of the page while the camera framed the menu
 *   that opened it, at the right edge. Its Delete button still fell inside the frame, so
 *   the camera stayed - and cut the dialog in half at the frame's left edge.
 * - A click that closed a dialog, or turned a button into a badge elsewhere, left the
 *   camera pointing at where the action had been, for as long as the narration ran.
 *
 * So a target inside a dialog or menu is framed together with it, and a click that
 * opens or closes one, or makes its own target disappear, ends the shot.
 */

import type { Locator, Page } from 'playwright-core'

/** Layers whose arrival or departure changes what the viewer is looking at. */
const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  'dialog[open]',
  '[aria-modal="true"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(', ')

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

/**
 * The region to frame for `target`: the target itself, or - when it sits in a dialog
 * or menu - the target together with the whole overlay, so the camera never crops the
 * sentence the button answers.
 */
export async function framingBox(target: Locator, targetBox: Box): Promise<Box> {
  const overlay = await target
    .evaluate((el, selector) => {
      const container = el.closest(selector)
      if (!container) return null
      const r = container.getBoundingClientRect()
      return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    }, OVERLAY_SELECTOR)
    .catch(() => null)
  return overlay ? union(targetBox, overlay) : targetBox
}

/** The dialogs and menus open and visible right now. */
export async function openOverlays(page: Page): Promise<Box[]> {
  return page
    .evaluate(selector => {
      return Array.from(document.querySelectorAll(selector))
        .map(el => {
          const r = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          const shown = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
          return shown ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
        })
        .filter((b): b is { x: number; y: number; width: number; height: number } => b !== null)
    }, OVERLAY_SELECTOR)
    .catch(() => [])
}

function inside(frame: Box, box: Box, margin = 4): boolean {
  return (
    box.x >= frame.x - margin &&
    box.y >= frame.y - margin &&
    box.x + box.width <= frame.x + frame.width + margin &&
    box.y + box.height <= frame.y + frame.height + margin
  )
}

/** The state of the scene just before an action, to compare with after it. */
export interface SceneMark {
  overlays: number
  acted?: Locator
}

export interface Camera {
  readonly page: Page
  readonly isZoomed: boolean
  /** The region of the page the camera shows while it is in. */
  readonly cameraFrame: Box | null
  releaseZoom(): void
  /**
   * The last click, kept so a change it causes later than its own beat - a badge that
   * appears once an API call returns - still pulls the camera out.
   */
  lastAction: SceneMark | null
}

/**
 * Pull the camera out if the action changed the scene beyond its frame. Returns whether
 * it pulled out.
 *
 * - A dialog or menu that closed: what it covered, or what it changed, is elsewhere.
 * - One that opened and does not fit in the frame: a confirmation in the middle of the
 *   page. A menu dropping open under its own button fits, and the camera stays.
 * - The element acted on is gone: a button that turned into a badge, a menu item whose
 *   menu closed. What replaced it is not what the frame was chosen for.
 */
export async function settleCamera(camera: Camera, before: SceneMark): Promise<boolean> {
  if (!camera.isZoomed) return false
  const overlays = await openOverlays(camera.page)
  const frame = camera.cameraFrame
  const closed = overlays.length < before.overlays
  const openedOutOfFrame =
    overlays.length > before.overlays && frame !== null && overlays.some(b => !inside(frame, b))
  const actedOnGone = before.acted
    ? !(await before.acted.isVisible().catch(() => false))
    : false
  if (!closed && !openedOutOfFrame && !actedOnGone) return false
  camera.releaseZoom()
  return true
}

/**
 * Look again at the scene the last click left behind, and pull out if it has changed
 * since. Called when the recording next waits, narrates or acts. Once the camera is out,
 * or the scene is as the click left it and the camera still fits it, nothing is kept.
 */
export async function settleLastAction(camera: Camera): Promise<boolean> {
  const mark = camera.lastAction
  if (!mark) return false
  const pulledOut = await settleCamera(camera, mark)
  if (pulledOut || !camera.isZoomed) camera.lastAction = null
  return pulledOut
}
