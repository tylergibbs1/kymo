import { FrameRef, type Track, fpsOf } from "@kymo/core"
import { Result, Schema } from "effect"
import { type Bezier, PRESETS, type Preset, bezierAt, minimize, springAt } from "./Curves.ts"
import type { FrameRange } from "./Range.ts"
import {
  type End,
  type MotionOptions,
  SegmentEnd,
  type Unfit,
  type WholeMotion,
  findMotion
} from "./Segment.ts"
import { round } from "./Stats.ts"
import { unitScale } from "./Units.ts"

const Rmse = Schema.Number.annotate({ description: "Root-mean-square error in normalised progress (0..1)." })

export const PresetFit = Schema.Struct({
  family: Schema.Literals(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]),
  css: Schema.String,
  rmse: Rmse
})
export const BezierFit = Schema.Struct({
  family: Schema.Literal("cubic-bezier"),
  css: Schema.String,
  x1: Schema.Number,
  y1: Schema.Number,
  x2: Schema.Number,
  y2: Schema.Number,
  rmse: Rmse
})
export const SpringFit = Schema.Struct({
  family: Schema.Literal("spring"),
  /** Mass 1: stiffness = ω₀², damping = 2ζω₀. */
  stiffness: Schema.Number,
  damping: Schema.Number,
  mass: Schema.Number,
  dampingRatio: Schema.Number,
  frequencyHz: Schema.Number,
  rmse: Rmse
})
export const EasingCandidate = Schema.Union([PresetFit, BezierFit, SpringFit])
export type EasingCandidate = typeof EasingCandidate.Type

export const EasingFit = Schema.Struct({
  track: Schema.String,
  from: FrameRef,
  to: FrameRef,
  /** The fitted segment as a range address. */
  address: Schema.String,
  durationFrames: Schema.Int,
  durationSeconds: Schema.Number,
  startValue: Schema.Number,
  endValue: Schema.Number,
  start: SegmentEnd.annotate({
    description:
      "How the start was seen. rest: it held still before. range: the range starts mid-motion. appeared: it was not visible before (faded in, or entered the frame), so from and startValue are estimated."
  }),
  end: SegmentEnd.annotate({
    description:
      "How the end was seen. rest: it holds still after. range: the range ends mid-motion. disappeared: it was not visible after (faded out, or left the frame), so to and endValue are estimated."
  }),
  /** Frames with a value that the fit used. */
  samples: Schema.Int,
  /** The simplest candidate whose error is close to the lowest. */
  best: EasingCandidate,
  /** Every family tried, lowest error first. */
  candidates: Schema.Array(EasingCandidate)
})
export type EasingFit = typeof EasingFit.Type

export type EasingOptions = MotionOptions

/** One curve family's shape: progress 0..1 at time fraction `x` (or `seconds` since the start). */
type Shape = (params: ReadonlyArray<number>) => (x: number, seconds: number) => number

interface Family {
  readonly shape: Shape
  /** Shape parameters to start the search from; the best result wins. */
  readonly starts: ReadonlyArray<ReadonlyArray<number>>
  readonly step: ReadonlyArray<number>
}

/**
 * The CSS presets and common design-system curves: Material's emphasized decelerate and standard,
 * an overshoot and an anticipation.
 */
const BEZIER_STARTS: ReadonlyArray<ReadonlyArray<number>> = [
  ...Object.values(PRESETS).map((b) => [b.x1, b.y1, b.x2, b.y2]),
  [0.05, 0.7, 0.1, 1],
  [0.2, 0, 0, 1],
  [0.3, 1.4, 0.6, 1],
  [0.6, -0.4, 0.7, 0.2]
]

interface Solved {
  readonly params: ReadonlyArray<number>
  readonly t0: number
  readonly t1: number
  readonly v0: number
  readonly v1: number
  readonly rmse: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** A spring within this fraction of its travel from the target has settled. */
const SETTLED = 0.005

/**
 * Fits shapes to a Motion. Seen ends fix their frame and value; unseen ends leave the frame free
 * within its bounds and solve the value by least squares, so a subject that fades in or leaves the
 * frame still gets its whole curve.
 */
const fitter = (motion: WholeMotion, fps: number, minTravel: number) => {
  const pts = motion.samples
  const bound = (e: End) => ({ lo: e.earliest, hi: e.latest, value: e.seen ? e.value : undefined })
  const s = bound(motion.start)
  const e = bound(motion.end)
  // Errors are in progress, 0..1. With an end unseen, its value is a fitted unknown, so the scale is
  // the travel actually seen: dividing by the fitted travel would reward inventing a huge one.
  const values = pts.map(([, v]) => v)
  const seenTravel = Math.max(...values) - Math.min(...values)
  const scaleOf = (travel: number) => (s.value !== undefined && e.value !== undefined ? travel : seenTravel)
  const freeStart = s.hi > s.lo
  const freeEnd = e.hi > e.lo
  const times = (p: ReadonlyArray<number>, k: number) => {
    let t0 = s.lo
    let t1 = e.lo
    if (freeStart) t0 = clamp(p[k++]!, s.lo, s.hi)
    if (freeEnd) t1 = clamp(p[k]!, e.lo, e.hi)
    return { t0, t1 }
  }
  const timeStart = [...(freeStart ? [(s.lo + s.hi) / 2] : []), ...(freeEnd ? [(e.lo + e.hi) / 2] : [])]
  const timeStep = timeStart.map(() => 1)

  const solve = (
    shape: (x: number, seconds: number) => number,
    t0: number,
    t1: number
  ): Solved | undefined => {
    const span = t1 - t0
    if (span <= 0) return undefined
    const ps = pts.map(([i]) => shape(clamp((i - t0) / span, 0, 1), Math.max(0, (i - t0) / fps)))
    const ys = pts.map(([, v]) => v)
    const n = ps.length
    let v0 = s.value
    let v1 = e.value
    if (v0 === undefined && v1 === undefined) {
      const mp = ps.reduce((a, b) => a + b, 0) / n
      const my = ys.reduce((a, b) => a + b, 0) / n
      let sxy = 0
      let sxx = 0
      for (let k = 0; k < n; k++) {
        sxy += (ps[k]! - mp) * (ys[k]! - my)
        sxx += (ps[k]! - mp) ** 2
      }
      if (sxx === 0) return undefined
      const slope = sxy / sxx
      v0 = my - slope * mp
      v1 = v0 + slope
    } else if (v0 === undefined) {
      const end = v1!
      let num = 0
      let den = 0
      for (let k = 0; k < n; k++) {
        num += (ys[k]! - end) * (1 - ps[k]!)
        den += (1 - ps[k]!) ** 2
      }
      if (den === 0) return undefined
      v0 = end + num / den
    } else if (v1 === undefined) {
      let num = 0
      let den = 0
      for (let k = 0; k < n; k++) {
        num += (ys[k]! - v0) * ps[k]!
        den += ps[k]! ** 2
      }
      if (den === 0) return undefined
      v1 = v0 + num / den
    }
    const travel = v1! - v0
    if (Math.abs(travel) < minTravel) return undefined
    let sq = 0
    const scale = scaleOf(travel)
    for (let k = 0; k < n; k++) sq += ((v0 + travel * ps[k]! - ys[k]!) / scale) ** 2
    return { params: [], t0, t1, v0, v1: v1!, rmse: Math.sqrt(sq / n) }
  }

  // Half-frame steps over each free bound.
  const grid = (lo: number, hi: number): Array<Array<number>> => {
    const n = Math.max(2, Math.ceil((hi - lo) * 2) + 1)
    return Array.from({ length: n }, (_, k) => [lo + ((hi - lo) * k) / (n - 1)])
  }
  const g0 = freeStart ? grid(s.lo, s.hi) : [[]]
  const g1 = freeEnd ? grid(e.lo, e.hi) : [[]]

  /** Error of a shape with every free frame at the middle of its bounds: a cheap screen for starts. */
  const score = (shape: Shape, params: ReadonlyArray<number>): number => {
    const { t0, t1 } = times([...params, ...timeStart], params.length)
    return solve(shape(params), t0, t1)?.rmse ?? 1e6
  }

  const fit = (family: Family): Solved => {
    const nShape = family.starts[0]!.length
    const objective = (p: ReadonlyArray<number>) => {
      const { t0, t1 } = times(p, nShape)
      return solve(family.shape(p.slice(0, nShape)), t0, t1)?.rmse ?? 1e6
    }
    const steps = [...family.step, ...timeStep]
    let point: ReadonlyArray<number> = [...family.starts[0]!, ...timeStart]
    let value = Infinity
    for (const shape of family.starts) {
      // Free frames start from the best of a grid, so the simplex begins in the right basin; a
      // restart from where it stopped gets it out of a collapsed simplex.
      let start: ReadonlyArray<number> = [...shape, ...timeStart]
      let best = Infinity
      for (const a of g0)
        for (const b of g1) {
          const p = [...shape, ...a, ...b]
          const v = objective(p)
          if (v < best) {
            best = v
            start = p
          }
        }
      if (start.length > 0) {
        start = minimize(objective, start, steps, 600).point
        start = minimize(objective, start, steps, 600).point
      }
      const v = objective(start)
      if (v < value) {
        value = v
        point = start
      }
    }
    const { t0, t1 } = times(point, nShape)
    const solved = solve(family.shape(point.slice(0, nShape)), t0, t1)
    return solved === undefined
      ? { params: point.slice(0, nShape), t0, t1, v0: Number.NaN, v1: Number.NaN, rmse: Infinity }
      : { ...solved, params: point.slice(0, nShape) }
  }
  return { fit, score }
}

const toBezier = (p: ReadonlyArray<number>): Bezier => ({
  x1: clamp(p[0]!, 0, 1),
  y1: clamp(p[1]!, -2, 3),
  x2: clamp(p[2]!, 0, 1),
  y2: clamp(p[3]!, -2, 3)
})

const cssOf = (b: Bezier) =>
  `cubic-bezier(${round(b.x1, 3)}, ${round(b.y1, 3)}, ${round(b.x2, 3)}, ${round(b.y2, 3)})`

/** Free parameters per family: the tie-breaker when errors are close. */
const complexity = (c: EasingCandidate): number =>
  c.family === "cubic-bezier" ? 4 : c.family === "spring" ? 2 : 0

/** Errors below this (a quarter of a percent of the travel) are equally good: no curve is told apart. */
const INDISTINCT = 0.0025

/**
 * The candidate with the lowest Bayesian information criterion: error traded against free
 * parameters for the number of samples, so a richer family must fit clearly better to win, and
 * among equally good fits the simplest wins. A candidate whose parameters ran into their bounds (a
 * spring damped 4×, a bezier handle at the limit) found no optimum of its own, so it is only picked
 * when every candidate did.
 */
const pickBest = <C extends { readonly candidate: EasingCandidate; readonly pinned: boolean }>(
  all: ReadonlyArray<C>,
  samples: number
): C => {
  const free = all.filter((c) => !c.pinned)
  const pool = free.length > 0 ? free : all
  const bic = (c: EasingCandidate) =>
    2 * samples * Math.log(Math.max(INDISTINCT, c.rmse)) + complexity(c) * Math.log(samples)
  return [...pool].sort(
    (a, b) =>
      bic(a.candidate) - bic(b.candidate) ||
      complexity(a.candidate) - complexity(b.candidate) ||
      a.candidate.rmse - b.candidate.rmse
  )[0]!
}

/** Spring start points: a grid over damping ratio and cycles per motion, for the simplex to polish. */
const springStart = (durationSeconds: number, f: (p: ReadonlyArray<number>) => number) => {
  let start = [0, 1]
  let best = Infinity
  for (const zeta of [0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1, 1.5, 2.5]) {
    for (const c of [1, 2, 4, 8, 16, 32, 64]) {
      const p = [Math.log(c / durationSeconds), zeta]
      const e = f(p)
      if (e < best) {
        best = e
        start = p
      }
    }
  }
  return start
}

/** An unseen end whose frame fits equally well over more frames than this is not determined. */
const UNDETERMINED = 3

/**
 * Fit the CSS presets, a free cubic-bezier and a damped spring to a whole Motion. Fails as partial
 * when an unseen end is not pinned down by what was seen (a linear exit fits any later stop).
 */
export const fitMotion = (motion: WholeMotion, range: FrameRange): Result.Result<EasingFit, Unfit> => {
  const fps = fpsOf(range.rate)
  const minTravel = unitScale(motion.unit).minTravel
  const fit = fitter(motion, fps, minTravel)
  const first = motion.samples[0]![0]
  const last = motion.samples[motion.samples.length - 1]![0]
  const seconds = Math.max(1, last - first) / fps

  const presets = (Object.keys(PRESETS) as Array<Preset>).map((family) => {
    const kind: Family = { shape: () => (x) => bezierAt(PRESETS[family], x), starts: [[]], step: [] }
    const solved = fit.fit(kind)
    return {
      candidate: { family, css: family, rmse: solved.rmse } as EasingCandidate,
      solved,
      kind,
      pinned: false
    }
  })
  const bezierKind: Family = {
    shape: (p) => {
      const b = toBezier(p)
      return (x) => bezierAt(b, x)
    },
    starts: BEZIER_STARTS,
    step: [0.15, 0.15, 0.15, 0.15]
  }
  const bezier = fit.fit(bezierKind)
  const springShape: Shape = (p) => {
    const sp = { omega: Math.exp(p[0]!), zeta: clamp(p[1]!, 0.02, 4) }
    return (_x, secs) => springAt(sp, secs)
  }
  const springKind: Family = {
    shape: springShape,
    starts: [springStart(seconds, (p) => fit.score(springShape, p))],
    step: [0.2, 0.1]
  }
  const spring = fit.fit(springKind)
  const b = toBezier(bezier.params)
  const omega = Math.exp(spring.params[0]!)
  const zeta = clamp(spring.params[1]!, 0.02, 4)
  // A spring never arrives: it ends where it stays within REST of its target, or where last seen.
  let settle = spring.t0
  for (let i = last; i >= spring.t0; i--) {
    if (Math.abs(1 - springAt({ omega, zeta }, (i - spring.t0) / fps)) > SETTLED) {
      settle = Math.min(last, i + 1)
      break
    }
  }
  const candidates = [
    ...presets,
    {
      candidate: {
        family: "cubic-bezier",
        css: cssOf(b),
        x1: round(b.x1, 3),
        y1: round(b.y1, 3),
        x2: round(b.x2, 3),
        y2: round(b.y2, 3),
        rmse: bezier.rmse
      } as EasingCandidate,
      solved: bezier,
      kind: bezierKind,
      pinned: [b.y1, b.y2].some((y) => y <= -2 || y >= 3)
    },
    {
      candidate: {
        family: "spring",
        stiffness: round(omega * omega, 2),
        damping: round(2 * zeta * omega, 2),
        mass: 1,
        dampingRatio: round(zeta, 3),
        frequencyHz: round(omega / (2 * Math.PI), 3),
        rmse: spring.rmse
      } as EasingCandidate,
      solved: { ...spring, t1: settle },
      kind: springKind,
      pinned: zeta <= 0.02 || zeta >= 4
    }
  ]
    .filter((c) => Number.isFinite(c.candidate.rmse))
    .map((c) => ({ ...c, candidate: { ...c.candidate, rmse: round(c.candidate.rmse, 5) } }))
    .sort((a, b) => a.candidate.rmse - b.candidate.rmse)
  const best = pickBest(candidates, motion.samples.length)

  // An unseen end with a wide window: refit the best family with that frame fixed at each frame of
  // the window; if many frames fit as well, the data does not say where the motion ended.
  for (const side of ["start", "end"] as const) {
    const e = motion[side]
    // A spring has no end frame: its target is solved for, so only its start is checked.
    if (
      e.seen ||
      e.latest - e.earliest <= UNDETERMINED ||
      (side === "end" && best.candidate.family === "spring")
    )
      continue
    const tolerance = best.candidate.rmse + Math.max(INDISTINCT, 0.25 * best.candidate.rmse)
    const good: Array<number> = []
    for (let t = Math.ceil(e.earliest); t <= Math.floor(e.latest); t++) {
      const fixed: WholeMotion = { ...motion, [side]: { ...e, earliest: t, latest: t } }
      const refit = fitter(fixed, fps, minTravel).fit({ ...best.kind, starts: [best.solved.params] })
      if (refit.rmse <= tolerance) good.push(t)
    }
    if (good.length > 0 && good[good.length - 1]! - good[0]! > UNDETERMINED) {
      const lo = good[0]!
      const hi = good[good.length - 1]!
      const seen = side === "start" ? motion.samples[0]![0] : last
      return Result.fail({
        track: motion.track,
        status: "partial",
        reason: `${motion.track} ${side === "start" ? "was already moving when it came into view" : "was still moving when it went out of view"} at ${range.ref(seen).address}, and what was seen fits ${side === "start" ? "a start" : "an end"} anywhere in ${range.spanText(lo, hi)}: the ${side} of the motion is not determined.`,
        from: range.ref(lo),
        to: range.ref(hi)
      })
    }
  }

  const from = Math.round(best.solved.t0)
  const to = Math.round(best.solved.t1)
  return Result.succeed({
    track: motion.track,
    from: range.ref(from),
    to: range.ref(to),
    address: range.spanText(from, to),
    durationFrames: to - from,
    durationSeconds: round((best.solved.t1 - best.solved.t0) / fps, 4),
    startValue: round(best.solved.v0, 3),
    endValue: round(best.solved.v1, 3),
    start: motion.start.kind,
    end: motion.end.kind,
    samples: motion.samples.length,
    best: best.candidate,
    candidates: candidates.map((c) => c.candidate)
  })
}

/**
 * Normalise a track's motion to 0..1 and fit the CSS presets, a free cubic-bezier and a damped
 * spring. Fails with an Unfit that says why when the motion was not seen whole (see `findMotion`).
 */
export const fitEasing = (
  track: Track,
  range: FrameRange,
  options: EasingOptions = {}
): Result.Result<EasingFit, Unfit> =>
  Result.flatMap(findMotion(track, range, options), (m) => fitMotion(m, range))
