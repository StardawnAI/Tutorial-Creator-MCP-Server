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

/**
 * Colours shared by every decoration, so the video looks like one piece of work - the
 * Stardawn cyan of the cards and the stage. That cyan all but vanishes on a white
 * page, so everything drawn in it carries a thin navy keyline as well.
 */
const ACCENT = '#01fff4'
const ACCENT_SOFT = 'rgba(1,255,244,.26)'
const KEYLINE = 'rgba(4,20,34,.62)'
const SCRIM = 'rgba(4,20,34,.5)'

/**
 * How a decoration leaves: a short fade, timed to end as its overlay is removed. It
 * used to vanish from one frame to the next, which reads as a glitch rather than as
 * something finishing. `forwards` only - a backwards fill would hold it at full
 * opacity through the delay and cancel the way it came in.
 */
const LEAVE_MS = 240
const leaveCss = `@keyframes tc-leave { to { opacity: 0 } }`
const leave = (durationMs: number) =>
  `tc-leave ${LEAVE_MS}ms ${Math.max(0, durationMs - LEAVE_MS)}ms ease-in forwards`

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

/** The ring itself, plus the keyframes every decoration shares. */
function ringMarkup(r: Box, dim: boolean, durationMs: number): { css: string; html: string } {
  const radius = Math.min(14, Math.max(8, Math.round(Math.min(r.width, r.height) * 0.18)))
  const scrim = dim ? `, 0 0 0 9999px ${SCRIM}` : ''
  const css = `
    ${leaveCss}
    @keyframes tc-settle {
      from { opacity: 0; transform: scale(1.06); }
      to   { opacity: 1; transform: scale(1); }
    }
    @keyframes tc-breathe {
      0%,100% { box-shadow: 0 0 0 1.5px ${KEYLINE}, 0 0 0 5px ${ACCENT_SOFT}${scrim}; }
      50%     { box-shadow: 0 0 0 1.5px ${KEYLINE}, 0 0 0 10px rgba(1,255,244,.14)${scrim}; }
    }
    @keyframes tc-rise { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
    .tc-ring {
      position: fixed; pointer-events: none;
      border: 2.5px solid ${ACCENT}; border-radius: ${radius}px;
      animation: tc-settle .26s cubic-bezier(.22,1,.36,1) both,
                 tc-breathe 2.1s ease-in-out .26s infinite,
                 ${leave(durationMs)};
    }`
  const html =
    `<div class="tc-ring" style="left:${Math.round(r.x)}px;top:${Math.round(r.y)}px;` +
    `width:${Math.round(r.width)}px;height:${Math.round(r.height)}px"></div>`
  return { css, html }
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
  options: { durationMs: number; dim?: boolean } = { durationMs: 1400 },
): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 }
  const { css, html } = ringMarkup(padded(box, 8, viewport), options.dim !== false, options.durationMs)

  await page.screencast
    .showOverlay(`<style>${css}</style>${html}`, { duration: options.durationMs })
    .catch(err => log.warn('Could not draw the spotlight', err))
}

/** Roughly how long this many words takes to read, in milliseconds. */
export function readingTimeMs(text: string): number {
  const words = text.trim().split(/\s+/).length
  return Math.min(7000, Math.max(1800, Math.round(words * 260) + 700))
}

/**
 * An instruction at the edge of the screen, with a line drawn to what it refers to.
 *
 * This replaces a caption pinned to the target itself, which turned out to be worth
 * nothing: a chip reading "Verify account" floating above a button reading "Verify
 * account" tells the viewer something they can already see, while covering whatever
 * is next to it. A tutorial has to say what the step is *for* - "choose a name, then
 * confirm to create the workspace" - and that does not fit on a chip, nor belong on
 * top of the thing it is describing.
 *
 * So the text sits in the margin, on whichever side the target is not, and a line
 * connects the two. It is shown before the camera moves in, while the whole page is
 * still visible and the instruction can be read in context.
 */
export interface InstructionLayout {
  card: Box
  /** Where the connecting line starts and ends, in viewport pixels. */
  line: { fromX: number; fromY: number; toX: number; toY: number }
  /** The padded ring around the target. */
  ring: Box
}

/**
 * Work out where the card goes relative to the target.
 *
 * Separated out so the one property that matters can be asserted directly rather
 * than eyeballed: the card must never overlap what it is pointing at. That is the
 * whole reason this exists instead of a caption pinned to the element.
 */
export function instructionLayout(
  box: Box,
  viewport: { width: number; height: number },
  text: string,
): InstructionLayout {
  const r = padded(box, 8, viewport)
  const margin = Math.round(viewport.width * 0.03)
  const cardWidth = Math.min(400, Math.max(260, Math.round(viewport.width * 0.24)))

  // Put the card in the emptier half, so it never lands on the thing it points at.
  const onRight = r.x + r.width / 2 < viewport.width / 2
  const cardX = onRight ? viewport.width - margin - cardWidth : margin

  // Beside the target where possible, nudged back inside the frame at the edges.
  const cardHeight = 42 + Math.ceil(text.length / 34) * 26
  const cardY = Math.max(
    margin,
    Math.min(viewport.height - margin - cardHeight, r.y + r.height / 2 - cardHeight / 2),
  )

  return {
    card: { x: cardX, y: cardY, width: cardWidth, height: cardHeight },
    // From the card's inner edge to the nearest side of the ring.
    line: {
      fromX: onRight ? cardX : cardX + cardWidth,
      fromY: cardY + cardHeight / 2,
      toX: onRight ? r.x + r.width + 6 : r.x - 6,
      toY: r.y + r.height / 2,
    },
    ring: r,
  }
}

export async function instruct(
  page: Page,
  box: Box,
  text: string,
  options: { durationMs?: number; dim?: boolean } = {},
): Promise<number> {
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 }
  const durationMs = options.durationMs ?? readingTimeMs(text)

  const layout = instructionLayout(box, viewport, text)
  const { card, line, ring: r } = layout
  const { x: cardX, y: cardY, width: cardWidth, height: cardHeight } = card
  const { fromX, fromY, toX, toY } = line
  const length = Math.round(Math.hypot(toX - fromX, toY - fromY))
  const angle = (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI

  const { css, html: ring } = ringMarkup(r, options.dim !== false, durationMs)

  const overlay =
    `<style>${css}
      .tc-card {
        position: fixed; pointer-events: none; box-sizing: border-box;
        width: ${cardWidth}px;
        font: 500 17px/1.45 "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif;
        color: #f4f7fa; background: rgba(6,22,36,.95);
        border: 1px solid rgba(1,255,244,.26);
        border-radius: 12px; padding: 15px 18px 15px 22px;
        box-shadow: 0 18px 44px rgba(0,0,0,.45), 0 0 0 1px ${KEYLINE};
        animation: tc-rise .34s cubic-bezier(.22,1,.36,1) both, ${leave(durationMs)};
      }
      /* The accent down the card's edge runs cyan to magenta, as on the cards. */
      .tc-card::before {
        content: ''; position: absolute; left: 8px; top: 12px; bottom: 12px; width: 3px;
        border-radius: 2px; background: linear-gradient(180deg, ${ACCENT}, #ff1178);
      }
      /* A rotated div rather than an SVG line. SVG markup handed to showOverlay does
         not render in the screencast's overlay layer - the connector was simply
         absent from every frame - while plain elements do. */
      @keyframes tc-draw {
        from { transform: rotate(${angle}deg) scaleX(0) }
        to   { transform: rotate(${angle}deg) scaleX(1) }
      }
      @keyframes tc-fade { from { opacity: 0 } to { opacity: 1 } }
      .tc-line {
        position: fixed; pointer-events: none; height: 2.5px; border-radius: 2px;
        background: ${ACCENT}; transform-origin: 0 50%; box-shadow: 0 0 0 1px ${KEYLINE};
        animation: tc-draw .5s .2s cubic-bezier(.4,0,.2,1) both, ${leave(durationMs)};
      }
      .tc-dot {
        position: fixed; pointer-events: none;
        width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px;
        border-radius: 50%; background: ${ACCENT}; box-shadow: 0 0 0 1.5px ${KEYLINE};
        animation: tc-fade .3s .55s both, ${leave(durationMs)};
      }
    </style>` +
    `<div class="tc-line" style="left:${Math.round(fromX)}px;top:${Math.round(fromY)}px;` +
    `width:${length}px"></div>` +
    `<div class="tc-dot" style="left:${Math.round(toX)}px;top:${Math.round(toY)}px"></div>` +
    ring +
    `<div class="tc-card" style="left:${cardX}px;top:${cardY}px">${escapeHtml(text)}</div>`

  await page.screencast
    .showOverlay(overlay, { duration: durationMs })
    .catch(err => log.warn('Could not draw the instruction', err))

  return durationMs
}

/**
 * A band across the top of the page saying what the person watching has to do.
 *
 * The one thing here that is put into the page rather than into the screencast's
 * overlay layer, and deliberately. Everything else is decoration for the viewer of
 * the finished video; this is for the person sitting at the machine, who has to see
 * it in the window in front of them - and nobody has proved that the capture overlay
 * is painted on screen as well as into the file.
 *
 * It is fixed, it ignores the mouse, and it is taken out again the moment the person
 * is done, so the app it sits over is not affected. It also never reaches the video:
 * a handoff happens off camera.
 */
const HANDOFF_ID = 'tutorial-handoff-banner'

export async function showHandoffBanner(page: Page, instruction: string): Promise<void> {
  await page
    .evaluate(
      ([id, message]) => {
        document.getElementById(id as string)?.remove()
        const banner = document.createElement('div')
        banner.id = id as string
        banner.textContent = message as string
        banner.style.cssText = [
          'position:fixed',
          'left:0',
          'right:0',
          'top:0',
          'z-index:2147483647',
          'pointer-events:none',
          'padding:14px 20px',
          'font:600 17px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
          'color:#0b1220',
          'background:#fbbf24',
          'box-shadow:0 6px 20px rgba(0,0,0,.35)',
          'text-align:center',
        ].join(';')
        document.documentElement.appendChild(banner)
      },
      [HANDOFF_ID, instruction],
    )
    .catch(err => log.warn('Could not show the handoff banner', err))
}

export async function clearHandoffBanner(page: Page): Promise<void> {
  await page
    .evaluate(id => document.getElementById(id)?.remove(), HANDOFF_ID)
    .catch(() => {
      // The page may have navigated away, which removes it anyway.
    })
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
        border: 3px solid ${ACCENT}; background: rgba(1,255,244,.16);
        box-shadow: 0 0 0 1.5px ${KEYLINE};
        animation: tc-ripple ${durationMs}ms cubic-bezier(.16,.8,.35,1) both;
      }
    </style>` +
    `<div class="tc-ripple" style="left:${Math.round(x)}px;top:${Math.round(y)}px"></div>`

  await page.screencast
    .showOverlay(html, { duration: durationMs })
    .catch(err => log.warn('Could not draw the click ripple', err))
}

/** How a Playwright key name is written on a keycap. */
const KEY_LABELS: Record<string, string> = {
  Control: 'Ctrl',
  ControlOrMeta: 'Ctrl',
  Meta: 'Win',
  Escape: 'Esc',
  Enter: 'Enter ↵',
  Backspace: '⌫',
  Delete: 'Del',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  ' ': 'Space',
}

/** "Control+Shift+k" becomes the caps Ctrl, Shift, K. */
export function keycaps(key: string): string[] {
  // A lone "+" is a key of its own; split only on a "+" that joins two names.
  return key
    .split(/(?<=.)\+(?=.)/)
    .map(part => KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part))
}

/**
 * The keys being pressed, as keycaps near the bottom of what the viewer sees.
 *
 * A shortcut is otherwise invisible on video: nothing moves until the app reacts, and
 * the viewer cannot tell what made it happen. Set high enough to stay clear of the
 * captions, which sit at the bottom of the finished frame.
 *
 * "What the viewer sees" is the camera's frame when it is in. Placed at the bottom of
 * the page instead, the keys for pressing Enter in a search box at the top were drawn
 * well outside the magnified region, and never appeared in the video. Inside the
 * frame they are shrunk by the magnification, so they come out the same size at any
 * zoom.
 */
export async function keystroke(
  page: Page,
  key: string,
  options: { frame?: Box & { scale: number } } = {},
  durationMs = 1300,
): Promise<void> {
  const caps = keycaps(key)
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 }
  const frame = options.frame ?? { x: 0, y: 0, ...viewport, scale: 1 }
  const anchorX = Math.round(frame.x + frame.width / 2)
  const anchorY = Math.round(frame.y + frame.height * 0.82)
  const html =
    `<style>${leaveCss}
      @keyframes tc-pop {
        from { opacity: 0; transform: translateY(12px) scale(.96) }
        to   { opacity: 1; transform: none }
      }
      .tc-anchor {
        position: fixed; pointer-events: none; left: ${anchorX}px; top: ${anchorY}px;
        transform: translate(-50%, -100%) scale(${(1 / frame.scale).toFixed(4)});
        transform-origin: 50% 100%;
      }
      .tc-keys {
        display: flex; align-items: center; gap: 12px;
        padding: 12px 14px; border-radius: 18px;
        background: rgba(6,22,36,.92); box-shadow: 0 16px 40px rgba(0,0,0,.4), 0 0 0 1px ${KEYLINE};
        font: 600 27px/1 "Segoe UI", ui-sans-serif, system-ui, sans-serif; color: #f4f7fa;
        animation: tc-pop .28s cubic-bezier(.22,1,.36,1) both, ${leave(durationMs)};
      }
      .tc-keys kbd {
        font: inherit; min-width: 54px; padding: 12px 17px; text-align: center; box-sizing: border-box;
        border-radius: 10px; background: linear-gradient(180deg, #16324a, #0e2334);
        border: 1px solid rgba(1,255,244,.3); box-shadow: 0 3px 0 rgba(0,0,0,.45);
      }
      .tc-keys span { color: #9fb3c2; font-weight: 500; }
    </style>` +
    `<div class="tc-anchor"><div class="tc-keys">` +
    `${caps.map(c => `<kbd>${escapeHtml(c)}</kbd>`).join('<span>+</span>')}</div></div>`

  await page.screencast
    .showOverlay(html, { duration: durationMs })
    .catch(err => log.warn('Could not draw the keystroke', err))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
