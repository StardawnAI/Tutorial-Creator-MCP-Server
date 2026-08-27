/**
 * The layer that tells the viewer where to look.
 *
 * A raw screen capture of an app is a poor teacher: the pointer arrives somewhere,
 * something changes, and the viewer works out afterwards what was clicked. Marking
 * the target *before* acting on it is the difference between a screen recording and
 * a tutorial.
 *
 * Everything here is drawn into the screencast's own overlay layer, never into the
 * page. The application under demonstration is not modified, so nothing here can
 * change its layout, its behaviour, or what the recording is supposed to prove.
 */

import type { Page } from 'playwright-core'
import { log } from './logger.js'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Colours shared by every decoration, so the video looks like one piece of work. */
const ACCENT = '#38bdf8'
const ACCENT_SOFT = 'rgba(56,189,248,.28)'
const SCRIM = 'rgba(8,15,30,.46)'

/** Keep a decoration inside the frame, and give it a little breathing room. */
function padded(box: Box, pad: number, viewport: { width: number; height: number }): Box {
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  return {
    x,
    y,
    width: Math.min(viewport.width - x, box.width + pad * 2),
    height: Math.min(viewport.height - y, box.height + pad * 2),
  }
}

/**
 * A ring around the target with everything else dimmed.
 *
 * The ring settles inward rather than appearing flat, which reads as "look here"
 * instead of as a static annotation. The scrim is what actually does the work: with
 * the rest of the screen pushed back, the eye has nowhere else to go.
 */
export async function spotlight(
  page: Page,
  box: Box,
  options: { durationMs: number; label?: string; dim?: boolean } = { durationMs: 1400 },
): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 }
  const r = padded(box, 8, viewport)
  const dim = options.dim !== false
  const radius = Math.min(14, Math.max(8, Math.round(Math.min(r.width, r.height) * 0.18)))

  // A label is only worth showing when it fits above the target; below it would
  // cover whatever the click is about to reveal.
  const labelTop = r.y - 34
  const label =
    options.label && labelTop > 8
      ? `<div class="tc-label" style="left:${Math.round(r.x)}px;top:${Math.round(labelTop)}px">` +
        `${escapeHtml(options.label)}</div>`
      : ''

  const html =
    `<style>
      @keyframes tc-settle {
        from { opacity: 0; transform: scale(1.06); }
        to   { opacity: 1; transform: scale(1); }
      }
      @keyframes tc-breathe {
        0%,100% { box-shadow: 0 0 0 4px ${ACCENT_SOFT}${dim ? `, 0 0 0 9999px ${SCRIM}` : ''}; }
        50%     { box-shadow: 0 0 0 9px rgba(56,189,248,.16)${dim ? `, 0 0 0 9999px ${SCRIM}` : ''}; }
      }
      @keyframes tc-fade-in { from { opacity: 0 } to { opacity: 1 } }
      .tc-ring {
        position: fixed; pointer-events: none;
        border: 2.5px solid ${ACCENT}; border-radius: ${radius}px;
        animation: tc-settle .26s cubic-bezier(.22,1,.36,1) both,
                   tc-breathe 2.1s ease-in-out .26s infinite;
      }
      .tc-label {
        position: fixed; pointer-events: none;
        font: 600 15px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #f8fafc; background: rgba(15,23,42,.92);
        border: 1px solid rgba(56,189,248,.5); border-radius: 7px;
        padding: 7px 11px; letter-spacing: .1px; white-space: nowrap;
        box-shadow: 0 8px 22px rgba(0,0,0,.4);
        animation: tc-fade-in .26s ease-out both;
      }
    </style>` +
    `<div class="tc-ring" style="left:${Math.round(r.x)}px;top:${Math.round(r.y)}px;` +
    `width:${Math.round(r.width)}px;height:${Math.round(r.height)}px"></div>${label}`

  await page.screencast
    .showOverlay(html, { duration: options.durationMs })
    .catch(err => log.warn('Could not draw the spotlight', err))
}

/**
 * A pulse at the point of contact, shown as the click lands.
 *
 * Playwright's own cursor decoration moves the pointer to the target but gives no
 * signal at the moment of the click, which on video is exactly the moment that
 * needs to be unmistakable.
 */
export async function ripple(page: Page, x: number, y: number, durationMs = 700): Promise<void> {
  const html =
    `<style>
      @keyframes tc-ripple {
        from { transform: scale(.3); opacity: .85; }
        to   { transform: scale(1);  opacity: 0; }
      }
      .tc-ripple {
        position: fixed; pointer-events: none;
        width: 108px; height: 108px; margin: -54px 0 0 -54px; border-radius: 50%;
        border: 3px solid ${ACCENT}; background: rgba(56,189,248,.18);
        animation: tc-ripple ${durationMs}ms cubic-bezier(.16,.8,.35,1) both;
      }
    </style>` +
    `<div class="tc-ripple" style="left:${Math.round(x)}px;top:${Math.round(y)}px"></div>`

  await page.screencast
    .showOverlay(html, { duration: durationMs })
    .catch(err => log.warn('Could not draw the click ripple', err))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
