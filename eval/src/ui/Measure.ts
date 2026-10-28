/**
 * Reading answers off recorded browser truth. Pure functions over per-frame series; every threshold
 * is a "visible" one (a pixel, or an opacity step worth a pixel), and the frame tolerances come from
 * how far the answer moves when that threshold is halved or doubled, so a slow tail that is honestly
 * hard to call gets a wider window than a hard switch.
 */
import type { Box } from "../Task.ts"

export interface Frame {
  readonly width: number
  readonly height: number
}

/** An element's state at one frame: its unclipped layout box and its on-screen opacity. */
export interface State {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly opacity: number
}

/** Opacity change that counts as much as one pixel of movement. */
const OPACITY_PER_PIXEL = 1 / 50

interface Clipped {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
  readonly visible: boolean
}

const clip = (s: State, f: Frame): Clipped => {
  const x0 = Math.min(Math.max(s.x, 0), f.width)
  const y0 = Math.min(Math.max(s.y, 0), f.height)
  const x1 = Math.min(Math.max(s.x + s.w, 0), f.width)
  const y1 = Math.min(Math.max(s.y + s.h, 0), f.height)
  return { x0, y0, x1, y1, visible: x1 > x0 && y1 > y0 && s.opacity > 0 }
}

/**
 * How visibly two states differ, in pixels: edge movement of the on-screen part, weighted by how
 * opaque it is, or an opacity change converted to pixels. Two invisible states never differ.
 */
export const visibleChange = (a: State, b: State, f: Frame): number => {
  const ca = clip(a, f)
  const cb = clip(b, f)
  if (!ca.visible && !cb.visible) return 0
  const weight = Math.max(ca.visible ? a.opacity : 0, cb.visible ? b.opacity : 0)
  const edges = Math.max(
    Math.abs(ca.x0 - cb.x0),
    Math.abs(ca.y0 - cb.y0),
    Math.abs(ca.x1 - cb.x1),
    Math.abs(ca.y1 - cb.y1)
  )
  return Math.max(edges * weight, Math.abs(a.opacity - b.opacity) / OPACITY_PER_PIXEL)
}

export interface Located {
  readonly index: number
  readonly tolerance: number
}

/** The answer at a 1 px threshold, with a tolerance covering where 0.5 px and 2 px would put it. */
const located = (
  at: (threshold: number) => number | undefined,
  minTolerance: number
): Located | undefined => {
  const index = at(1)
  const lo = at(0.5)
  const hi = at(2)
  if (index === undefined || lo === undefined || hi === undefined) return undefined
  return { index, tolerance: Math.max(minTolerance, Math.abs(lo - index), Math.abs(hi - index)) }
}

/** The first frame that visibly differs from 0f. */
export const startOf = (states: ReadonlyArray<State>, f: Frame): Located | undefined =>
  located((t) => {
    const i = states.findIndex((s) => visibleChange(s, states[0]!, f) >= t)
    return i < 0 ? undefined : i
  }, 1)

/**
 * The first frame from which the element stays visibly where it ends. Undefined if it still moves
 * by more than `stillWithin` px between the last two frames (exact for truth; measured tracks jitter).
 */
export const settleOf = (states: ReadonlyArray<State>, f: Frame, stillWithin = 0.01): Located | undefined => {
  const n = states.length
  if (n < 2 || visibleChange(states[n - 1]!, states[n - 2]!, f) > stillWithin) return undefined
  return located((t) => {
    for (let i = n - 1; i >= 0; i--) if (visibleChange(states[i]!, states[n - 1]!, f) >= t) return i + 1
    return 0
  }, 2)
}

/** The on-screen part of a box, grown to whole pixels. Undefined when nothing is on screen. */
export const boxOf = (s: State, f: Frame): Box | undefined => {
  const c = clip(s, f)
  if (!c.visible) return undefined
  const x = Math.floor(c.x0)
  const y = Math.floor(c.y0)
  return { x, y, w: Math.ceil(c.x1) - x, h: Math.ceil(c.y1) - y }
}

/** Fully on screen and opaque, so a tracker can start from its box at 0f. */
export const fullyShown = (s: State, f: Frame): boolean =>
  s.opacity >= 0.99 && s.x >= 0 && s.y >= 0 && s.x + s.w <= f.width && s.y + s.h <= f.height

/** Progress from the first value to the last, 0..1 (beyond 1 on overshoot). */
export const progressOf = (v: ReadonlyArray<number>): Array<number> => {
  const first = v[0]!
  const span = v[v.length - 1]! - first
  return v.map((x) => (span === 0 ? 0 : (x - first) / span))
}

/** The axis that moves furthest. */
export const mainAxis = (x: ReadonlyArray<number>, y: ReadonlyArray<number>): ReadonlyArray<number> => {
  const range = (v: ReadonlyArray<number>) => Math.max(...v) - Math.min(...v)
  return range(x) >= range(y) ? x : y
}

/**
 * Frame indices where the direction of travel reverses: each local extreme that the value then moves
 * away from by more than `hysteresis` (0 for exact truth; measured tracks need slack for jitter).
 */
export const turningPoints = (v: ReadonlyArray<number>, hysteresis = 0): Array<number> => {
  const out: Array<number> = []
  let direction = 0
  let extreme = 0
  for (let i = 1; i < v.length; i++) {
    const d = v[i]! - v[extreme]!
    if (direction === 0) {
      if (Math.abs(v[i]! - v[0]!) > hysteresis) [direction, extreme] = [Math.sign(v[i]! - v[0]!), i]
    } else if (d * direction > 0) extreme = i
    else if (-d * direction > hysteresis) {
      out.push(extreme)
      direction = -direction
      extreme = i
    }
  }
  return out
}

/** Frames inside the moving span that repeat the previous position, and frames that land after a double step. */
export const stutters = (v: ReadonlyArray<number>): { repeats: Array<number>; skips: Array<number> } => {
  const d = v.map((x, i) => (i === 0 ? 0 : x - v[i - 1]!))
  const moving = d.flatMap((x, i) => (Math.abs(x) > 0.01 ? [i] : []))
  const first = moving[0]
  const last = moving[moving.length - 1]
  if (first === undefined || last === undefined) return { repeats: [], skips: [] }
  const steps = moving.map((i) => Math.abs(d[i]!)).sort((a, b) => a - b)
  const typical = steps[Math.floor(steps.length / 2)]!
  const repeats: Array<number> = []
  const skips: Array<number> = []
  for (let i = first; i <= last; i++) {
    if (Math.abs(d[i]!) <= 0.01) repeats.push(i)
    else if (Math.abs(d[i]!) > 1.5 * typical) skips.push(i)
  }
  return { repeats, skips }
}
