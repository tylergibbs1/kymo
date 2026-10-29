/**
 * Whether a box visibly changed between two frames. Three things look like change and are not:
 * encoder noise (a pixel must change by more than the clip's noise and at least `VISIBLE_STEP`), an
 * edge creeping by less than half a pixel (a pixel on an edge must change by more than half a pixel
 * of that edge's movement would make it), and the page dimming or brightening behind the box (a
 * scrim): when most of the ring around the box changed by one overlay toward black or white, the
 * box's pixels that changed by that same overlay are not counted.
 */
import { CHANGED_FRACTION } from "./Difference.ts"
import type { DiffLevels } from "./Pixels.ts"
import { robustLine } from "./RobustFit.ts"
import { MIN_MOVING_PIXELS, noiseLevelOf } from "./Signals.ts"

/**
 * Below 2% of full scale (5 of 255 luma steps) a change between two frames is not visible on screen
 * content, and is what H.264 leaves behind as it re-encodes a still picture.
 */
export const VISIBLE_STEP = 5

/** An edge must move by at least this much of a source pixel for its pixels to count as changed. */
const SUBPIXEL = 0.5

/** The `edge` of a rule read at `scale` working pixels per source pixel: half a source pixel. */
export const subpixelEdge = (scale: number): number => SUBPIXEL * scale

/**
 * The luma steps a pixel must change by to count, from frame pairs that show the clip's encoder noise
 * (consecutive frames): that noise, and never less than `VISIBLE_STEP`. Every per-pixel change rule
 * takes its floor from here.
 */
export const visibleFloor = (pairs: ReadonlyArray<DiffLevels>): number =>
  Math.max(VISIBLE_STEP, noiseLevelOf(pairs))

/** The ring explains the box only when more than this share of it changed, and fits one overlay this well. */
const RING_SHARE = 0.5

/** A ring smaller than this many pixels says nothing about the page around the box. */
const MIN_RING = 16

/** One frame's box and a ring of its surroundings, in grey levels (0..255) at the working resolution. */
export interface Patch {
  readonly width: number
  readonly height: number
  readonly data: ArrayLike<number>
}

/** The box inside its patch, `[x0, x1) × [y0, y1)` in patch pixels; the rest of the patch is the ring. */
export interface Inner {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export interface Rule {
  /** Luma steps a pixel must change by to count: at least `VISIBLE_STEP`, more on a noisy clip. */
  readonly floor: number
  /**
   * Working pixels an edge must move by for its pixels to count (0: any change beyond the floor).
   * `subpixelEdge` gives half a source pixel, the least that changes which pixel an edge falls in.
   */
  readonly edge: number
}

export interface Visible {
  /** Box pixels that visibly changed. */
  readonly changed: number
  /** Box pixels compared. */
  readonly total: number
  /** Summed luma change (0..255) of the changed pixels. */
  readonly sum: number
  /** A dim or brighten of the whole ring was taken out of the box's change. */
  readonly discounted: boolean
}

/** A change covers a short edge (a few pixels) and more than 0.1% of the box, as compare counts a change. */
export const isVisible = (v: Visible): boolean =>
  v.changed >= MIN_MOVING_PIXELS && v.changed > CHANGED_FRACTION * v.total

/** Any movement at all: a short edge changed, however small a part of the box that is. */
export const anyMovement = (v: Visible): boolean => v.changed >= MIN_MOVING_PIXELS

/**
 * How many pixels changed by each luma step, for the clip's noise estimate: the box's, and the
 * ring's (none when the patch has no ring). The ring usually stays still while the box changes, so
 * it shows the noise even over a range where the box never rests.
 */
export const patchLevels = (
  ref: Patch,
  cur: Patch,
  inner: Inner
): { readonly box: DiffLevels; readonly ring: DiffLevels | undefined } => {
  const box = new Uint32Array(256)
  const ring = new Uint32Array(256)
  let ringPixels = 0
  for (let y = 0; y < ref.height; y++)
    for (let x = 0; x < ref.width; x++) {
      const k = y * ref.width + x
      const d = Math.min(255, Math.round(Math.abs(cur.data[k]! - ref.data[k]!)))
      if (inside(inner, x, y)) box[d]! += 1
      else {
        ring[d]! += 1
        ringPixels++
      }
    }
  return { box, ring: ringPixels >= MIN_RING ? ring : undefined }
}

/** The largest step from a pixel to one of its four neighbours: how sharp an edge it sits on. */
const edgeAt = (p: Patch, x: number, y: number): number => {
  const w = p.width
  const d = p.data
  const v = d[y * w + x]!
  let most = 0
  if (x > 0) most = Math.max(most, Math.abs(d[y * w + x - 1]! - v))
  if (x + 1 < w) most = Math.max(most, Math.abs(d[y * w + x + 1]! - v))
  if (y > 0) most = Math.max(most, Math.abs(d[(y - 1) * w + x]! - v))
  if (y + 1 < p.height) most = Math.max(most, Math.abs(d[(y + 1) * w + x]! - v))
  return most
}

const inside = (inner: Inner, x: number, y: number) =>
  x >= inner.x0 && x < inner.x1 && y >= inner.y0 && y < inner.y1

/**
 * The overlay the ring shows, as `cur = ref + alpha · (target − ref)`: a scrim fading in over the
 * page (toward black) or a wash toward white. Undefined unless most of the ring changed and most of
 * it fits that one overlay.
 */
const ringOverlay = (
  ref: Patch,
  cur: Patch,
  inner: Inner,
  floor: number
): { readonly alpha: number; readonly target: number } | undefined => {
  const shifts = new Uint32Array(511)
  let n = 0
  let moved = 0
  for (let y = 0; y < ref.height; y++)
    for (let x = 0; x < ref.width; x++) {
      if (inside(inner, x, y)) continue
      const k = y * ref.width + x
      const d = Math.round(cur.data[k]! - ref.data[k]!)
      shifts[d + 255]! += 1
      n++
      if (Math.abs(d) > floor) moved++
    }
  if (n < MIN_RING || moved <= RING_SHARE * n) return undefined
  let seen = 0
  let median = 0
  for (let d = 0; d < 511; d++) {
    seen += shifts[d]!
    if (seen * 2 >= n) {
      median = d - 255
      break
    }
  }
  const target = median < 0 ? 0 : 255
  let num = 0
  let den = 0
  for (let y = 0; y < ref.height; y++)
    for (let x = 0; x < ref.width; x++) {
      if (inside(inner, x, y)) continue
      const k = y * ref.width + x
      const toward = target - ref.data[k]!
      num += (cur.data[k]! - ref.data[k]!) * toward
      den += toward * toward
    }
  const alpha = den > 0 ? Math.min(1, num / den) : 0
  if (alpha <= 0) return undefined
  let fits = 0
  for (let y = 0; y < ref.height; y++)
    for (let x = 0; x < ref.width; x++) {
      if (inside(inner, x, y)) continue
      const k = y * ref.width + x
      const r = ref.data[k]!
      if (Math.abs(cur.data[k]! - r - alpha * (target - r)) <= floor) fits++
    }
  return fits >= RING_SHARE * n ? { alpha, target } : undefined
}

/**
 * The way the box's look changes over a range, last frame minus first, on the pixels it changes by
 * more than the floor: a fade or cross-fade moves every pixel along it in proportion.
 */
export interface Direction {
  /** Per patch pixel, last − first; 0 outside the box and where the change is under the floor. */
  readonly data: Float32Array
}

/** The box's change from `first` to `last`, or undefined when too few of its pixels change to say. */
export const directionOf = (
  first: Patch,
  last: Patch,
  inner: Inner,
  floor: number
): Direction | undefined => {
  const data = new Float32Array(first.width * first.height)
  let pixels = 0
  for (let y = inner.y0; y < inner.y1; y++)
    for (let x = inner.x0; x < inner.x1; x++) {
      const k = y * first.width + x
      const d = last.data[k]! - first.data[k]!
      if (Math.abs(d) <= floor) continue
      data[k] = d
      pixels++
    }
  const total = (inner.x1 - inner.x0) * (inner.y1 - inner.y0)
  return isVisible({ changed: pixels, total, sum: 0, discounted: false }) ? { data } : undefined
}

/** How a frame's box differs from a reference frame's, split into a fade and what a fade does not explain. */
export interface Difference {
  /**
   * How far along the box's `Direction` the frame is from the reference: the fraction of the whole
   * fade or cross-fade between them (0 without a direction). For an element fading in place over a
   * plain page it is the change in its opacity.
   */
  readonly fade: number
  /** One standard error of `fade`. */
  readonly fadeNoise: number
  /** Box pixels that changed beyond the fade, the floor, and what an edge moving under `rule.edge` does. */
  readonly moved: Visible
}

/**
 * How `cur` differs from `ref` inside the box: the fade along `direction` that the box's pixels agree
 * on (a robust fit, so pixels that moved do not bend it), and the pixels the fade does not explain.
 * A dim or brighten of the whole ring (a scrim) is taken out first, as in `visibleChange`.
 */
export const difference = (
  ref: Patch,
  cur: Patch,
  inner: Inner,
  rule: Rule,
  direction: Direction | undefined,
  radius: number
): Difference => {
  const overlay = ringOverlay(ref, cur, inner, rule.floor)
  const w = ref.width
  const limitAt = (x: number, y: number) =>
    Math.max(rule.floor, rule.edge * Math.max(edgeAt(ref, x, y), edgeAt(cur, x, y)))
  const explained = (k: number, d: number, limit: number) =>
    overlay !== undefined && Math.abs(d - overlay.alpha * (overlay.target - ref.data[k]!)) <= limit
  let fade = 0
  let fadeNoise = 0
  if (direction !== undefined) {
    const xs: Array<number> = []
    const ys: Array<number> = []
    for (let y = inner.y0; y < inner.y1; y++)
      for (let x = inner.x0; x < inner.x1; x++) {
        const k = y * w + x
        const dir = direction.data[k]!
        if (dir === 0) continue
        const d = cur.data[k]! - ref.data[k]!
        if (explained(k, d, limitAt(x, y))) continue
        xs.push(dir)
        ys.push(d)
      }
    // Encoder noise is about half the floor (the floor is where noise stops); a fit closer than that is luck.
    const line = robustLine(xs, ys, xs.length, rule.floor / 2, false)
    if (line !== undefined) {
      fade = line.slope
      fadeNoise = line.slopeNoise
    }
  }
  const near = nearby(radius)
  let changed = 0
  let sum = 0
  for (let y = inner.y0; y < inner.y1; y++)
    for (let x = inner.x0; x < inner.x1; x++) {
      const k = y * w + x
      const d = cur.data[k]! - ref.data[k]!
      const rest = d - fade * (direction?.data[k] ?? 0)
      const limit = limitAt(x, y)
      if (Math.abs(rest) <= limit || explained(k, d, limit)) continue
      // Moved by less than `rule.edge`: the reference shows this value somewhere that close.
      const v = ref.data[k]! + rest
      let lo = Infinity
      let hi = -Infinity
      for (const [ox, oy] of near) {
        const s = bilinear(ref, x + ox, y + oy)
        if (s < lo) lo = s
        if (s > hi) hi = s
      }
      if (v >= lo - rule.floor && v <= hi + rule.floor) continue
      changed++
      sum += Math.abs(rest)
    }
  return {
    fade,
    fadeNoise,
    moved: {
      changed,
      total: (inner.x1 - inner.x0) * (inner.y1 - inner.y0),
      sum,
      discounted: overlay !== undefined
    }
  }
}

/**
 * Offsets (working pixels) closer than `radius` to a pixel, a quarter pixel apart or finer: where an
 * edge moving less than `radius` could have come from. Values between two of them are reached too,
 * as the picture is continuous between its samples.
 */
const nearby = (radius: number): ReadonlyArray<readonly [number, number]> => {
  const step = Math.min(0.25, radius / 2)
  const reach = Math.ceil(radius / step)
  const out: Array<readonly [number, number]> = []
  for (let j = -reach; j <= reach; j++)
    for (let i = -reach; i <= reach; i++)
      if (Math.hypot(i * step, j * step) < radius) out.push([i * step, j * step])
  return out.length > 0 ? out : [[0, 0]]
}

/** `p` at a fractional pixel position, clamped to its edges. */
const bilinear = (p: Patch, x: number, y: number): number => {
  const u = Math.max(0, Math.min(p.width - 1, x))
  const v = Math.max(0, Math.min(p.height - 1, y))
  const x0 = Math.floor(u)
  const y0 = Math.floor(v)
  const x1 = Math.min(x0 + 1, p.width - 1)
  const y1 = Math.min(y0 + 1, p.height - 1)
  const fx = u - x0
  const fy = v - y0
  const d = p.data
  const top = d[y0 * p.width + x0]! + fx * (d[y0 * p.width + x1]! - d[y0 * p.width + x0]!)
  const bot = d[y1 * p.width + x0]! + fx * (d[y1 * p.width + x1]! - d[y1 * p.width + x0]!)
  return top + fy * (bot - top)
}

/** Which of the box's pixels changed visibly from `ref` to `cur`, two patches cut the same way. */
export const visibleChange = (ref: Patch, cur: Patch, inner: Inner, rule: Rule): Visible => {
  const overlay = ringOverlay(ref, cur, inner, rule.floor)
  const { edge } = rule
  const w = ref.width
  let changed = 0
  let sum = 0
  for (let y = inner.y0; y < inner.y1; y++)
    for (let x = inner.x0; x < inner.x1; x++) {
      const k = y * w + x
      const r = ref.data[k]!
      const d = cur.data[k]! - r
      const a = Math.abs(d)
      if (a <= rule.floor) continue
      const limit = Math.max(rule.floor, edge * Math.max(edgeAt(ref, x, y), edgeAt(cur, x, y)))
      if (a <= limit) continue
      if (overlay !== undefined && Math.abs(d - overlay.alpha * (overlay.target - r)) <= limit) continue
      changed++
      sum += a
    }
  return {
    changed,
    total: (inner.x1 - inner.x0) * (inner.y1 - inner.y0),
    sum,
    discounted: overlay !== undefined
  }
}
