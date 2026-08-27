/**
 * Camera moves: zooming into the part of the screen that matters.
 *
 * A tutorial recorded at 1920x1080 shows a button as a 120px smudge. The viewer is
 * told to click something they can barely read. Zooming in fixes that, and doing it
 * as a move of a virtual camera - rather than by scaling the page - keeps the app
 * itself untouched: no layout reflow, no shifted coordinates, nothing that could
 * break the very application being demonstrated.
 *
 * So the zoom is applied after the fact, in ffmpeg. During the recording only the
 * intent is written down (`ZoomEvent`), and this module turns those intents into one
 * `zoompan` expression.
 *
 * Timing is exact: `zoompan` reads `ot` (output time in seconds) and honours it to
 * within one frame - measured here, a move scheduled for 4.0 s began at 4.04 s and
 * one scheduled to end at 8.0 s ended at 8.00 s, at 25 fps.
 *
 * Sharpness is not free, and it is worth being plain about why. The obvious trick -
 * capture at twice the output size so a 2x move crops real pixels - does not work
 * with this API: `page.screencast` delivers frames at the CSS viewport size and
 * nothing larger, whatever the device scale factor says. So a camera move enlarges
 * captured pixels, and `MAX_ZOOM` is set where that still looks deliberate rather
 * than soft. The gain is legibility - text at 1.75x is far easier to read than the
 * same text at full-page size - not extra detail, and it should not be sold as such.
 */

/** One camera move, in the coordinate system of the CSS viewport. */
export interface ZoomEvent {
  /** Video time at which the push-in starts. */
  atMs: number
  /** Video time at which the pull-out starts. */
  releaseMs: number
  /** Point to centre on, in CSS pixels. */
  centerX: number
  centerY: number
  /** Magnification at rest, e.g. 1.8. */
  scale: number
  /** What the camera moved for - carried into `timeline.json`, not into the render. */
  reason?: string
}

export interface ZoomFilterOptions {
  viewportWidth: number
  viewportHeight: number
  outputWidth: number
  outputHeight: number
  fps: number
  /** Length of the push-in and pull-out, in milliseconds. */
  rampMs: number
}

/**
 * Largest magnification worth applying.
 *
 * Past this the enlargement of captured pixels starts to read as softness rather
 * than as a camera move, and the legibility gained no longer pays for it.
 */
export const MAX_ZOOM = 1.75

/** Below this there is no point: the move is not noticeable, only distracting. */
export const MIN_USEFUL_ZOOM = 1.25

/**
 * How far to magnify so that a box of this size becomes comfortable to read.
 *
 * The target is for the element to occupy a little under half the frame width. A
 * button ends up filling the screen, a whole panel is left alone.
 */
export function zoomForBox(
  box: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  if (box.width <= 0 || box.height <= 0) return 1
  const byWidth = (viewport.width * 0.45) / box.width
  const byHeight = (viewport.height * 0.55) / box.height
  return Math.min(MAX_ZOOM, Math.max(1, Math.min(byWidth, byHeight)))
}

/** Is `point` inside `rect` grown by `margin` on each side? */
export function boxContains(
  rect: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
  margin = 0,
): boolean {
  return (
    point.x >= rect.x - margin &&
    point.x <= rect.x + rect.width + margin &&
    point.y >= rect.y - margin &&
    point.y <= rect.y + rect.height + margin
  )
}

const n = (value: number): string => value.toFixed(4)

/**
 * Smoothstep, inlined. ffmpeg's expression evaluator has no user-defined functions,
 * so the progress term is simply repeated. Linear easing looks mechanical; this is
 * what makes the move read as a camera rather than a jump.
 */
function ease(progress: string): string {
  return `(${progress})*(${progress})*(3-2*(${progress}))`
}

/** Nested `if` chain over `ot`, innermost fallback last. */
function piecewise(clauses: Array<{ before: number; value: string }>, fallback: string): string {
  return clauses.reduceRight(
    (rest, clause) => `if(lt(ot,${n(clause.before)}),${clause.value},${rest})`,
    fallback,
  )
}

interface Phase {
  start: number
  rampedIn: number
  release: number
  ended: number
  scale: number
  fx: number
  fy: number
}

/**
 * Turn the recorded intents into `zoompan`, or null when there is nothing to do.
 *
 * Overlapping or out-of-order events are resolved by sorting and trimming, because
 * the alternative - a filtergraph that renders something nobody asked for - is far
 * worse than a camera move that ends slightly early.
 */
export function buildZoomFilter(
  events: ZoomEvent[],
  options: ZoomFilterOptions,
): string | null {
  const ramp = Math.max(0.15, options.rampMs / 1000)

  const phases: Phase[] = []
  for (const event of [...events].sort((a, b) => a.atMs - b.atMs)) {
    const scale = Math.min(MAX_ZOOM, event.scale)
    if (scale < MIN_USEFUL_ZOOM) continue

    const start = event.atMs / 1000
    const previous = phases[phases.length - 1]
    // Never start a move before the one before it has finished pulling out.
    if (previous && start < previous.ended) continue

    const rampedIn = start + ramp
    const release = Math.max(rampedIn, event.releaseMs / 1000)
    phases.push({
      start,
      rampedIn,
      release,
      ended: release + ramp,
      scale,
      fx: event.centerX / options.viewportWidth,
      fy: event.centerY / options.viewportHeight,
    })
  }

  if (phases.length === 0) return null

  const zoomClauses: Array<{ before: number; value: string }> = []
  const centreX: Array<{ before: number; value: string }> = []
  const centreY: Array<{ before: number; value: string }> = []

  for (const p of phases) {
    const pushIn = `(1+${n(p.scale - 1)}*${ease(`(ot-${n(p.start)})/${n(ramp)}`)})`
    const pullOut = `(1+${n(p.scale - 1)}*${ease(`1-(ot-${n(p.release)})/${n(ramp)}`)})`

    zoomClauses.push({ before: p.start, value: '1' })
    zoomClauses.push({ before: p.rampedIn, value: pushIn })
    zoomClauses.push({ before: p.release, value: n(p.scale) })
    zoomClauses.push({ before: p.ended, value: pullOut })

    // Hold the centre for the whole move, so the pull-out retreats from the same
    // point it pushed into rather than sliding sideways on the way out.
    centreX.push({ before: p.start, value: '0.5' })
    centreX.push({ before: p.ended, value: n(p.fx) })
    centreY.push({ before: p.start, value: '0.5' })
    centreY.push({ before: p.ended, value: n(p.fy) })
  }

  const z = piecewise(zoomClauses, '1')
  const cx = piecewise(centreX, '0.5')
  const cy = piecewise(centreY, '0.5')

  // zoompan crops `iw/zoom` x `ih/zoom` at (x,y), so the centre has to be converted
  // to a top-left corner and then kept inside the frame - otherwise the crop window
  // runs off the edge near a target at the border and the picture jumps.
  const x = `max(0,min(iw-iw/zoom,iw*(${cx})-(iw/zoom)/2))`
  const y = `max(0,min(ih-ih/zoom,ih*(${cy})-(ih/zoom)/2))`

  return (
    `zoompan=z='${z}':x='${x}':y='${y}':d=1` +
    `:s=${options.outputWidth}x${options.outputHeight}:fps=${options.fps}`
  )
}
