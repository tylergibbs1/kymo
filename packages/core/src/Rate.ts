import { Schema } from "effect"

/** A frame index: a non-negative integer. All time in kymo is stored as one of these plus a Rate. */
export const FrameIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("FrameIndex"))
export type FrameIndex = typeof FrameIndex.Type

export const frameIndex = (n: number): FrameIndex => FrameIndex.make(n)

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * A frame rate as an exact rational, e.g. 30000/1001 for NTSC. A Timeline's rate is also its clock:
 * on a variable-frame-rate source it carries every frame's presentation time (see `variableRate`),
 * so `secondsAt`, `indexAtSeconds` and every address formatted with it agree with the frames' `t`.
 */
export const Rate = Schema.Struct({ num: PositiveInt, den: PositiveInt })
export type Rate = typeof Rate.Type

export const rate = (num: number, den = 1): Rate => Rate.make({ num, den })

export const fpsOf = (r: Rate): number => r.num / r.den

/** Frames per "second" in a timecode. Integer by construction, so timecodes round-trip exactly. */
export const timecodeBase = (r: Rate): number => Math.max(1, Math.round(fpsOf(r)))

/** Presentation times of a variable-rate clock: frame i starts at `starts[i]`; the last one ends at `end`. */
export interface VariableClock {
  readonly starts: ReadonlyArray<number>
  readonly end: number
}

/** Not enumerable and symbol-keyed: never serialised, never compared, only read through `clockOf`. */
const CLOCK = Symbol.for("@kymo/core/VariableClock")

/**
 * The rate of a variable-frame-rate source: its average rate, carrying each frame's start time.
 * Adapters build their Timeline's rate with this, so every consumer of `timeline.rate` reads real
 * presentation times without knowing the source is variable.
 */
export const variableRate = (average: Rate, clock: VariableClock): Rate => {
  const r = { num: average.num, den: average.den }
  Object.defineProperty(r, CLOCK, { value: clock, enumerable: false })
  return r
}

/** The per-frame times of a variable-rate clock, or undefined for a constant rate. */
export const clockOf = (r: Rate): VariableClock | undefined =>
  (r as Rate & { readonly [CLOCK]?: VariableClock })[CLOCK]

/** Presentation time in seconds of a frame (or of the end, at index = frame count). */
export const secondsAt = (r: Rate, index: number): number => {
  const clock = clockOf(r)
  if (clock === undefined) return (index * r.den) / r.num
  const n = clock.starts.length
  return index < n ? clock.starts[Math.max(0, index)]! : clock.end + ((index - n) * r.den) / r.num
}

/** Labels are written to the millisecond, so a time that close to a frame's start still names it. */
const TOLERANCE = 0.0005

/**
 * The frame for a time in seconds. Constant rate: the nearest frame. Variable rate: the frame on
 * screen at that time (the last one starting at or before it); -1 before the start, the frame count
 * at or after the end, so bounds checks name the problem.
 */
export const indexAtSeconds = (r: Rate, seconds: number): number => {
  const clock = clockOf(r)
  if (clock === undefined) return Math.round((seconds * r.num) / r.den)
  const { starts, end } = clock
  if (seconds < starts[0]! - TOLERANCE) return -1
  if (seconds >= end - TOLERANCE && seconds > starts[starts.length - 1]! + TOLERANCE) return starts.length
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= seconds + TOLERANCE) lo = mid
    else hi = mid - 1
  }
  return lo
}
