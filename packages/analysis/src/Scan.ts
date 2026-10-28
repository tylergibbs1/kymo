import { type FrameIndex, type KymoError, type Source, frameIndex } from "@kymo/core"
import { Effect, Stream } from "effect"
import { type Gray, histogram, histogramDistance, meanAbsDiff, meanLuma, toGray } from "./Pixels.ts"
import type { FrameRange } from "./Range.ts"

/** Per-frame pixel statistics. Differences compare a frame with the one before it. */
export interface FrameStat {
  readonly index: FrameIndex
  /** Mean luma, 0..1. */
  readonly luma: number
  /** Luma histogram, normalised. Kept so later passes can compare any two frames. */
  readonly histogram: Float32Array
  /** Mean absolute luma difference from the previous frame, 0..1. Null for frame 0. */
  readonly motion: number | null
  /** Histogram distance from the previous frame, 0..1. Null for frame 0. */
  readonly histDiff: number | null
}

/** One decode pass over a range: everything the pixel analyses need, without the pixels. */
export interface Scan {
  readonly range: FrameRange
  /** `frames[k]` is frame `range.first + k`. */
  readonly frames: ReadonlyArray<FrameStat>
}

/** Analysis reads frames small: long edge at most this many pixels. */
export const SCAN_MAX_EDGE = 96

/**
 * Decode `range` once, streaming, at `SCAN_MAX_EDGE`. Holds one previous frame
 * in memory, never the whole range. Frame `first - 1` is read too when it exists,
 * so the first frame of a sub-range still gets a motion value.
 */
export const scan = (source: Source, range: FrameRange): Effect.Effect<Scan, KymoError> =>
  Effect.suspend(() => {
    const lead = range.first > 0 ? [frameIndex(range.first - 1)] : []
    const indices = [...lead, ...range.indices()]
    const frames: Array<FrameStat> = []
    let prev: { gray: Gray; histogram: Float32Array } | undefined
    return Stream.runForEach(source.readFrames(indices, { maxEdge: SCAN_MAX_EDGE }), (frame) =>
      Effect.sync(() => {
        const gray = toGray(frame.image)
        const h = histogram(gray)
        if (frame.index >= range.first) {
          frames.push({
            index: frame.index,
            luma: meanLuma(gray),
            histogram: h,
            motion: prev ? meanAbsDiff(prev.gray, gray) : null,
            histDiff: prev ? histogramDistance(prev.histogram, h) : null
          })
        }
        prev = { gray, histogram: h }
      })
    ).pipe(Effect.as({ range, frames }))
  })
