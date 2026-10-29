import { Address, FrameRef, type Track } from "@kymo/core"
import { Result, Schema } from "effect"
import type { FrameRange } from "./Range.ts"
import { round } from "./Stats.ts"
import type { LostReason, LostSpan } from "./Tracker.ts"
import { unitScale } from "./Units.ts"

/** Inclusive frame indices where a track moves from one resting value to another. */
export interface Segment {
  readonly from: number
  readonly to: number
}

/** A value within this fraction of the track's span counts as resting. */
const REST = 0.005

/** How many frames a measured motion's start or end may sit from where its values first settle. */
const BLUR = 2

/** A motion seen in fewer frames than this cannot pin down a curve. */
export const MIN_SAMPLES = 6

/** Known samples of `track` inside `range`, as [index, value] pairs. */
export const knownSamples = (track: Track, range: FrameRange): Array<readonly [number, number]> => {
  const out: Array<readonly [number, number]> = []
  for (let i = range.first; i <= range.last; i++) {
    const v = track.samples[i]
    if (v !== null && v !== undefined) out.push([i, v])
  }
  return out
}

const restingSegment = (
  samples: ReadonlyArray<readonly [number, number]>,
  noise: number
): Segment | undefined => {
  if (samples.length < 2) return undefined
  const values = samples.map(([, v]) => v)
  const span = Math.max(...values) - Math.min(...values)
  if (span === 0) return undefined
  const tol = Math.max(REST * span, noise)
  const v0 = values[0]!
  const v1 = values[values.length - 1]!
  let a = 0
  while (a + 1 < values.length && Math.abs(values[a + 1]! - v0) <= tol) a++
  let b = values.length - 1
  while (b - 1 > a && Math.abs(values[b - 1]! - v1) <= tol) b--
  const dir = Math.sign(v1 - v0) || Math.sign(values[a + 1]! - values[a]!)
  const tiny = Math.max(1e-6 * span, noise / 2)
  const step = (k: number) => values[k]! - values[k - 1]!
  while (a > 0 && Math.sign(step(a)) === dir && Math.abs(step(a)) > tiny) a--
  while (b < values.length - 1 && Math.sign(step(b + 1)) === dir && Math.abs(step(b + 1)) > tiny) b++
  return { from: samples[a]![0], to: samples[b]![0] }
}

/**
 * Where the value leaves its starting rest and arrives at its final rest.
 * The ends are widened while the value keeps stepping the same way, so slow
 * ease-in/out tails are kept. Undefined when the track never moves.
 */
export const movingSegment = (samples: ReadonlyArray<readonly [number, number]>): Segment | undefined =>
  restingSegment(samples, 0)

/**
 * How one end of a motion was seen. `rest`: the value holds still beyond it. `range`: the range
 * cuts the motion there. `appeared` / `disappeared`: the subject was not visible beyond it (it faded,
 * or was outside the frame), so that end's frame and value are estimated by the fit.
 */
export const SegmentEnd = Schema.Literals(["rest", "range", "appeared", "disappeared"])
export type SegmentEnd = typeof SegmentEnd.Type

/**
 * One end of a motion. It happened somewhere in `earliest..latest` (frame indices; equal when the
 * frame is exact). A seen end also has its value: the range bound's sample, or the mean of the rest.
 * A rest's frame is a window because measured values reach their rest within noise, not exactly.
 */
interface SeenEnd {
  readonly seen: true
  readonly kind: "rest" | "range"
  readonly earliest: number
  readonly latest: number
  readonly value: number
}

interface UnseenEnd {
  readonly seen: false
  readonly kind: "appeared" | "disappeared"
  readonly earliest: number
  readonly latest: number
}

export type End = SeenEnd | UnseenEnd

/**
 * A whole motion: every frame between its ends known, both ends seen or bounded, at least
 * MIN_SAMPLES samples, travelling at least the unit's minimum. Only `findMotion` makes one, so an
 * easing is never fitted to a part of a motion.
 */
export interface WholeMotion {
  readonly track: string
  readonly unit: string
  /** Every frame of the seen part, in order, none missing. */
  readonly samples: ReadonlyArray<readonly [number, number]>
  readonly start: End
  readonly end: End
}

/** Why a track has no easing fit. */
export const UnfitStatus = Schema.Literals(["lost", "partial", "too-few-samples", "no-motion"])
export type UnfitStatus = typeof UnfitStatus.Type

export const Unfit = Schema.Struct({
  track: Schema.String,
  status: UnfitStatus.annotate({
    description:
      "lost: no frame has a value. partial: part of the motion was not seen (lost frames inside it or at an end). too-few-samples: the motion lasts too few frames to fit. no-motion: it changes less than the unit's minimum (2 px, 0.02 for 0..1)."
  }),
  reason: Schema.String,
  /** The frames the reason is about, when it is about some frames. */
  from: Schema.optionalKey(FrameRef),
  to: Schema.optionalKey(FrameRef)
})
export type Unfit = typeof Unfit.Type

/** Why each frame has no value: the subject was not visible there, or the value is just unknown. */
type Gap = "gone" | "unknown"

const gapOf = (reason: LostReason | undefined): Gap =>
  reason === "edge" || reason === "faded" ? "gone" : "unknown"

export interface MotionOptions {
  /** How reasons name frames. */
  readonly labelStyle: Address.LabelStyle
  /** `auto` (default) finds where the value starts and stops changing; `exact` takes the whole range. */
  readonly segment?: "auto" | "exact"
  /** Why the track's null samples are null (a tracked region's `lost`); unexplained nulls are unknown. */
  readonly lost?: ReadonlyArray<LostSpan>
}

const fmt = (v: number) => String(round(v, 3))

/**
 * The motion inside `range` that an easing can be fitted to: the largest run of known frames that
 * moves, with each end at a rest, the range bound, or where the subject appeared or disappeared.
 * Anything else (lost frames inside or at an end, too few samples, too little travel) is an Unfit
 * that says why.
 */
export const findMotion = (
  track: Track,
  range: FrameRange,
  options: MotionOptions
): Result.Result<WholeMotion, Unfit> => {
  const name = track.name
  const unit = unitScale(track.unit)
  const span = (a: number, b: number) => Address.styledSpan(range.rate, a, b, options.labelStyle)
  const address = (i: number) => Address.styledAddress(range.rate, i, options.labelStyle)
  const all = span(range.first, range.last)
  const reasons = new Map<number, LostReason>()
  for (const l of options.lost ?? [])
    for (let i = l.from.index; i <= l.to.index; i++) reasons.set(i, l.reason)
  const unfit = (
    status: UnfitStatus,
    reason: string,
    from?: number,
    to?: number
  ): Result.Result<WholeMotion, Unfit> =>
    Result.fail({
      track: name,
      status,
      reason,
      ...(from === undefined ? {} : { from: range.ref(from) }),
      ...(to === undefined ? {} : { to: range.ref(to) })
    })

  const known = knownSamples(track, range)
  if (known.length === 0)
    return unfit(
      "lost",
      reasons.size > 0
        ? `${name} has no value in ${all}: the region was lost in every frame.`
        : `${name} has no known value in ${all}.`
    )
  if (known.length < MIN_SAMPLES && reasons.size > 0)
    return unfit(
      "lost",
      `${name} has a value in only ${known.length} of the ${range.count} frames of ${all}: the region was lost in the rest.`
    )

  // Runs of consecutive known frames.
  const runs: Array<Array<readonly [number, number]>> = []
  for (const s of known) {
    const run = runs[runs.length - 1]
    if (run && run[run.length - 1]![0] === s[0] - 1) run.push(s)
    else runs.push([s])
  }
  const travelOf = (xs: ReadonlyArray<readonly [number, number]>) => {
    const v = xs.map(([, x]) => x)
    return Math.max(...v) - Math.min(...v)
  }
  const travel = travelOf(known)
  const tracked = known.length < range.count ? " where it has a value" : ""
  if (travel < unit.minTravel)
    return unfit(
      "no-motion",
      unit.minTravel > Number.MIN_VALUE
        ? `${name} changes by ${fmt(travel)} ${track.unit} in ${all}${tracked}, under the ${unit.minTravel} ${track.unit} that counts as motion.`
        : `${name} does not change in ${all}${tracked}.`
    )

  /** The lost frames next to `index` on one side, and why the first of them is lost. */
  const gapBeside = (index: number, dir: -1 | 1) => {
    let far = index + dir
    while (far + dir >= range.first && far + dir <= range.last && track.samples[far + dir] == null) far += dir
    return { near: index + dir, far, gap: gapOf(reasons.get(index + dir)), reason: reasons.get(index + dir) }
  }
  const lostText = (a: number, b: number, reason: LostReason | undefined) =>
    `${span(Math.min(a, b), Math.max(a, b))}${reason === undefined ? "" : ` (${reason})`}`

  if (options.segment === "exact") {
    const missing = range.indices().find((i) => track.samples[i] == null)
    if (missing !== undefined) {
      const g = gapBeside(missing - 1, 1)
      return unfit(
        "partial",
        `${name} has no value in ${lostText(g.near, g.far, g.reason)}, so ${all} was not seen whole.`,
        g.near,
        g.far
      )
    }
    return motionOf(name, track.unit, known, known, "range", "range", unfit)
  }

  const run = runs.reduce((a, b) => (travelOf(b) > travelOf(a) ? b : a))
  if (travelOf(run) < unit.minTravel) {
    const g = gapBeside(run[run.length - 1]![0], 1)
    return unfit(
      "partial",
      `${name} changes across frames with no value (${lostText(g.near, g.far, g.reason)}), so its motion was not seen.`,
      g.near,
      g.far
    )
  }
  const seg = restingSegment(run, unit.noise)
  if (seg === undefined) return unfit("no-motion", `${name} does not change in ${all}.`)
  const runFirst = run[0]![0]
  const runLast = run[run.length - 1]![0]
  const valueAt = (i: number) => run[i - runFirst]![1]
  const tol = Math.max(REST * travelOf(run), unit.noise)
  // A rest is the frames beside the motion within noise of its value, up to half the motion's length.
  const reach = Math.max(2, Math.ceil((seg.to - seg.from) / 2))
  const restBeside = (index: number, dir: -1 | 1) => {
    const v = valueAt(index)
    const out = [index]
    for (let i = index + dir; i >= runFirst && i <= runLast && out.length <= reach; i += dir) {
      if (Math.abs(valueAt(i) - v) > tol) break
      out.push(i)
    }
    return out
  }
  const meanOf = (indices: ReadonlyArray<number>) =>
    indices.reduce((a, i) => a + valueAt(i), 0) / indices.length

  const startOf = (): Result.Result<End, Unfit> => {
    if (seg.from > runFirst) {
      const rest = restBeside(seg.from, -1)
      return Result.succeed({
        seen: true,
        kind: "rest",
        earliest: rest[Math.min(BLUR, rest.length - 1)]!,
        latest: Math.min(seg.from + BLUR, seg.to - 1),
        value: meanOf(rest)
      })
    }
    if (seg.from === range.first)
      return Result.succeed({
        seen: true,
        kind: "range",
        earliest: seg.from,
        latest: seg.from,
        value: valueAt(seg.from)
      })
    const g = gapBeside(seg.from, -1)
    if (g.gap === "gone")
      return Result.succeed({
        seen: false,
        kind: "appeared",
        earliest: g.reason === "faded" ? g.near : g.far,
        latest: g.near
      })
    return Result.fail({
      track: name,
      status: "partial",
      reason: `${name} has no value in ${lostText(g.near, g.far, g.reason)}, just before it is seen moving at ${address(seg.from)}: the start of the motion was not seen.`,
      from: range.ref(Math.min(g.near, g.far)),
      to: range.ref(Math.max(g.near, g.far))
    })
  }
  const endOf = (): Result.Result<End, Unfit> => {
    if (seg.to < runLast) {
      const rest = restBeside(seg.to, 1)
      return Result.succeed({
        seen: true,
        kind: "rest",
        earliest: Math.max(seg.to - BLUR, seg.from + 1),
        latest: rest[Math.min(BLUR, rest.length - 1)]!,
        value: meanOf(rest)
      })
    }
    if (seg.to === range.last)
      return Result.succeed({
        seen: true,
        kind: "range",
        earliest: seg.to,
        latest: seg.to,
        value: valueAt(seg.to)
      })
    const g = gapBeside(seg.to, 1)
    if (g.gap === "gone")
      return Result.succeed({
        seen: false,
        kind: "disappeared",
        earliest: g.near,
        latest: g.reason === "faded" ? g.near : g.far
      })
    return Result.fail({
      track: name,
      status: "partial",
      reason: `${name} was lost from ${address(g.near)} (${lostText(g.near, g.far, g.reason)}) while still moving: the end of the motion was not seen.`,
      from: range.ref(g.near),
      to: range.ref(g.far)
    })
  }
  const start = startOf()
  if (Result.isFailure(start)) return Result.fail(start.failure)
  const end = endOf()
  if (Result.isFailure(end)) return Result.fail(end.failure)
  const moving = run.filter(([i]) => i >= seg.from && i <= seg.to)
  const lo = start.success.seen ? start.success.earliest : seg.from
  const hi = end.success.seen ? end.success.latest : seg.to
  const samples = run.filter(([i]) => i >= lo && i <= hi)
  return motionOf(name, track.unit, moving, samples, start.success, end.success, unfit)
}

/** Check a found motion is long and large enough to fit; `samples` adds its rest frames to `moving`. */
const motionOf = (
  name: string,
  unit: string,
  moving: ReadonlyArray<readonly [number, number]>,
  samples: ReadonlyArray<readonly [number, number]>,
  start: End | "range",
  end: End | "range",
  unfit: (
    status: UnfitStatus,
    reason: string,
    from?: number,
    to?: number
  ) => Result.Result<WholeMotion, Unfit>
): Result.Result<WholeMotion, Unfit> => {
  if (moving.length < MIN_SAMPLES)
    return unfit(
      "too-few-samples",
      `${name} moves over ${moving.length} frames; a fit needs at least ${MIN_SAMPLES}.`,
      moving[0]![0],
      moving[moving.length - 1]![0]
    )
  const values = moving.map(([, v]) => v)
  const travel = Math.max(...values) - Math.min(...values)
  if (travel < unitScale(unit).minTravel)
    return unfit("no-motion", `${name} changes by ${fmt(travel)} ${unit}, under the minimum for a fit.`)
  const exact = (s: readonly [number, number]): End => ({
    seen: true,
    kind: "range",
    earliest: s[0],
    latest: s[0],
    value: s[1]
  })
  const from = start === "range" ? exact(samples[0]!) : start
  const to = end === "range" ? exact(samples[samples.length - 1]!) : end
  // An easing takes a value from one rest to another: a value that leaves and comes back (a dip, a
  // pulse) has no curve from start to end.
  if (from.seen && to.seen && Math.abs(to.value - from.value) < unitScale(unit).minTravel)
    return unfit(
      "no-motion",
      `${name} returns to where it started (${fmt(from.value)} to ${fmt(to.value)} ${unit}): it moves and comes back, which no single easing describes.`,
      moving[0]![0],
      moving[moving.length - 1]![0]
    )
  return Result.succeed({ track: name, unit, samples, start: from, end: to })
}
