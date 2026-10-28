import { Schema } from "effect"

/** A frame index: a non-negative integer. All time in kymo is stored as one of these plus a Rate. */
export const FrameIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("FrameIndex"))
export type FrameIndex = typeof FrameIndex.Type

export const frameIndex = (n: number): FrameIndex => FrameIndex.make(n)

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

/** A frame rate as an exact rational, e.g. 30000/1001 for NTSC. */
export const Rate = Schema.Struct({ num: PositiveInt, den: PositiveInt })
export type Rate = typeof Rate.Type

export const rate = (num: number, den = 1): Rate => Rate.make({ num, den })

export const fpsOf = (r: Rate): number => r.num / r.den

/** Frames per "second" in a timecode. Integer by construction, so timecodes round-trip exactly. */
export const timecodeBase = (r: Rate): number => Math.max(1, Math.round(fpsOf(r)))

/** Presentation time in seconds of a frame on a constant-rate clock. */
export const secondsAt = (r: Rate, index: FrameIndex): number => (index * r.den) / r.num

/** Nearest frame to a time in seconds. */
export const indexAtSeconds = (r: Rate, seconds: number): number => Math.round((seconds * r.num) / r.den)
