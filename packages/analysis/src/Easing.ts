import { FrameRef, InvalidInput, type Track, fpsOf } from "@kymo/core"
import { Result, Schema } from "effect"
import { type Bezier, PRESETS, type Preset, type Spring, bezierAt, minimize, springAt } from "./Curves.ts"
import type { FrameRange } from "./Range.ts"
import { type Segment, knownSamples, movingSegment } from "./Segment.ts"
import { round } from "./Stats.ts"

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
  /** The simplest candidate whose error is close to the lowest. */
  best: EasingCandidate,
  /** Every family tried, lowest error first. */
  candidates: Schema.Array(EasingCandidate)
})
export type EasingFit = typeof EasingFit.Type

export interface EasingOptions {
  /** `auto` (default) finds where the value starts and stops changing inside the range; `exact` fits the whole range. */
  readonly segment?: "auto" | "exact"
}

interface Point {
  /** Time fraction 0..1. */
  readonly x: number
  readonly seconds: number
  /** Normalised progress. */
  readonly y: number
}

const rmse = (points: ReadonlyArray<Point>, curve: (p: Point) => number): number =>
  Math.sqrt(points.reduce((s, p) => s + (curve(p) - p.y) ** 2, 0) / points.length)

const cssOf = (b: Bezier) =>
  `cubic-bezier(${round(b.x1, 3)}, ${round(b.y1, 3)}, ${round(b.x2, 3)}, ${round(b.y2, 3)})`

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

const fitBezier = (points: ReadonlyArray<Point>, start: Bezier) => {
  const toBezier = (p: ReadonlyArray<number>): Bezier => ({
    x1: clamp01(p[0]!),
    y1: Math.max(-2, Math.min(3, p[1]!)),
    x2: clamp01(p[2]!),
    y2: Math.max(-2, Math.min(3, p[3]!))
  })
  const { point } = minimize(
    (p) => rmse(points, (q) => bezierAt(toBezier(p), q.x)),
    [start.x1, start.y1, start.x2, start.y2],
    [0.15, 0.15, 0.15, 0.15]
  )
  const b = toBezier(point)
  return { b, error: rmse(points, (q) => bezierAt(b, q.x)) }
}

const fitSpring = (points: ReadonlyArray<Point>, durationSeconds: number) => {
  const toSpring = (p: ReadonlyArray<number>): Spring => ({
    omega: Math.exp(p[0]!),
    zeta: Math.max(0.02, Math.min(4, p[1]!))
  })
  const err = (p: ReadonlyArray<number>) => rmse(points, (q) => springAt(toSpring(p), q.seconds))
  let start = [0, 1]
  let bestErr = Infinity
  for (const zeta of [0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1, 1.5, 2.5]) {
    for (const c of [1, 2, 4, 8, 16, 32, 64]) {
      const p = [Math.log(c / durationSeconds), zeta]
      const e = err(p)
      if (e < bestErr) {
        bestErr = e
        start = p
      }
    }
  }
  const s = toSpring(minimize(err, start, [0.2, 0.1]).point)
  return { s, error: rmse(points, (q) => springAt(s, q.seconds)) }
}

/** Free parameters per family: the tie-breaker when errors are close. */
const complexity = (c: EasingCandidate): number =>
  c.family === "cubic-bezier" ? 4 : c.family === "spring" ? 2 : 0

const pickBest = (sorted: ReadonlyArray<EasingCandidate>): EasingCandidate => {
  const lowest = sorted[0]!.rmse
  const close = sorted.filter((c) => c.rmse <= lowest + Math.max(0.003, 0.25 * lowest))
  return [...close].sort((a, b) => complexity(a) - complexity(b) || a.rmse - b.rmse)[0]!
}

const noMotion = (track: Track, range: FrameRange) =>
  new InvalidInput({
    message: `${track.name} does not change between ${range.ref(range.first).address} and ${range.ref(range.last).address}.`,
    hint: `Pick a range where ${track.name} changes, or fit the whole clip with 0f..-1f.`
  })

/**
 * Normalise a track segment to 0..1 and fit the CSS presets, a free
 * cubic-bezier and a damped spring. Reports every candidate and the best.
 */
export const fitEasing = (
  track: Track,
  range: FrameRange,
  options: EasingOptions = {}
): Result.Result<EasingFit, InvalidInput> => {
  const samples = knownSamples(track, range)
  if (samples.length < 3) {
    return Result.fail(
      new InvalidInput({
        message: `${track.name} has ${samples.length} known samples in ${range.spanText(range.first, range.last)}; fitting needs at least 3.`,
        hint: "Widen the range, e.g. 0f..-1f, or pick a track with values there."
      })
    )
  }
  const segment: Segment | undefined =
    options.segment === "exact"
      ? { from: samples[0]![0], to: samples[samples.length - 1]![0] }
      : movingSegment(samples)
  const inside = segment ? samples.filter(([i]) => i >= segment.from && i <= segment.to) : []
  const v0 = inside[0]?.[1]
  const v1 = inside[inside.length - 1]?.[1]
  if (!segment || inside.length < 3 || v0 === undefined || v1 === undefined || v0 === v1) {
    return Result.fail(noMotion(track, range))
  }
  const fps = fpsOf(range.rate)
  const frames = segment.to - segment.from
  const points: Array<Point> = inside.map(([i, v]) => ({
    x: (i - segment.from) / frames,
    seconds: (i - segment.from) / fps,
    y: (v - v0) / (v1 - v0)
  }))

  const presets = (Object.keys(PRESETS) as Array<Preset>).map((family) => ({
    family,
    css: family,
    rmse: rmse(points, (p) => bezierAt(PRESETS[family], p.x))
  }))
  const nearest = [...presets].sort((a, b) => a.rmse - b.rmse)[0]!.family
  const free = fitBezier(points, PRESETS[nearest])
  const spring = fitSpring(points, frames / fps)
  const { omega, zeta } = spring.s
  const candidates: Array<EasingCandidate> = [
    ...presets,
    {
      family: "cubic-bezier",
      css: cssOf(free.b),
      x1: round(free.b.x1, 3),
      y1: round(free.b.y1, 3),
      x2: round(free.b.x2, 3),
      y2: round(free.b.y2, 3),
      rmse: free.error
    },
    {
      family: "spring",
      stiffness: round(omega * omega, 2),
      damping: round(2 * zeta * omega, 2),
      mass: 1,
      dampingRatio: round(zeta, 3),
      frequencyHz: round(omega / (2 * Math.PI), 3),
      rmse: spring.error
    }
  ]
  const sorted = candidates.map((c) => ({ ...c, rmse: round(c.rmse, 5) })).sort((a, b) => a.rmse - b.rmse)
  return Result.succeed({
    track: track.name,
    from: range.ref(segment.from),
    to: range.ref(segment.to),
    address: range.spanText(segment.from, segment.to),
    durationFrames: frames,
    durationSeconds: round(frames / fps, 4),
    startValue: v0,
    endValue: v1,
    best: pickBest(sorted),
    candidates: sorted
  })
}
