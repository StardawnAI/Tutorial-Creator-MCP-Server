/**
 * Repaint heartbeat.
 *
 * The screencast is event-driven: a frame is produced when the page repaints, and
 * not otherwise. A tutorial page sits perfectly still for most of the narration,
 * which is exactly when the recorded timeline goes wrong - measured here, an idle
 * page delivered 4 frames in 6 seconds, with a 3-second gap, and the resulting
 * video was a second longer than the wall clock it covered.
 *
 * This keeps a 1x1 px element in the corner nudging its colour on every animation
 * frame. It is invisible to a viewer but keeps the compositor emitting frames. With
 * it running, the same idle 6 seconds delivered 357 frames at a 17 ms median gap,
 * and video time tracked wall-clock time exactly.
 */

import type { Page } from 'playwright-core'
import { log } from './logger.js'

const HEARTBEAT_SOURCE = `
(() => {
  if (window.__tutorialHeartbeat) return;
  window.__tutorialHeartbeat = true;

  const dot = document.createElement('div');
  dot.setAttribute('data-tutorial-heartbeat', '');
  dot.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;' +
    'z-index:2147483647;pointer-events:none';

  const attach = () => {
    const root = document.documentElement;
    if (root && !dot.isConnected) root.appendChild(dot);
  };
  attach();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  }

  let i = 0;
  const tick = () => {
    // Two all-but-identical transparent blacks. The change is imperceptible but
    // is enough to make the compositor produce a frame.
    dot.style.background = (i++ % 2) ? 'rgba(0,0,0,0.004)' : 'rgba(0,0,0,0.008)';
    if (i % 120 === 0) attach();   // survive frameworks that wipe the DOM
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`

/** Install on this page and on every page it navigates to. */
export async function installHeartbeat(page: Page): Promise<void> {
  await page.addInitScript(HEARTBEAT_SOURCE)
  await page.evaluate(HEARTBEAT_SOURCE).catch(() => {
    // about:blank before the first navigation - the init script covers what follows
  })
  log.debug('Repaint heartbeat installed')
}
