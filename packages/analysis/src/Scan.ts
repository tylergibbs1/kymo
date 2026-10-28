import { type FrameIndex, type KymoError, type Source, frameIndex } from "@kymo/core"
import { Effect, Stream } from "effect"
import {
  type DiffLevels,
  type Gray,
  diffLevels,
  histogram,
  histogramDistance,
  levelsMean,
  meanAbsDiff,
  meanLuma,
  thumbnail,
  toGray
} from "./Pixels.ts"
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
  /** Mean absolute luma difference from two frames before, 0..1: what two steps of motion look like. */
  readonly motion2: number | null
  /** The same difference from the previous frame, counted per luma step, so noise can be told from change. */
  readonly levels: DiffLevels | null
  /** Histogram distance from the previous frame, 0..1. Null for frame 0. */
  readonly histDiff: number | null
  /** The frame at `THUMB_EDGE`, so later passes can compare any two frames' pictures. */
  readonly thumb: Gray
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
 * Decode `range` once, streaming, at `SCAN_MAX_EDGE`. Holds two previous frames
 * in memory, never the whole range. The two frames before `first` are read too when they exist,
 * so the first frames of a sub-range still get motion values.
 */
export const scan = (source: Source, range: FrameRange): Effect.Effect<Scan, KymoError> =>
  Effect.suspend(() => {
    const lead: Array<FrameIndex> = []
    for (let i = Math.max(0, range.first - 2); i < range.first; i++) lead.push(frameIndex(i))
    const indices = [...lead, ...range.indices()]
    const frames: Array<FrameStat> = []
    let prev: { gray: Gray; histogram: Float32Array } | undefined
    let before: Gray | undefined
    return Stream.runForEach(source.readFrames(indices, { maxEdge: SCAN_MAX_EDGE }), (frame) =>
      Effect.sync(() => {
        const gray = toGray(frame.image)
        const h = histogram(gray)
        if (frame.index >= range.first) {
          const levels = prev ? diffLevels(prev.gray, gray) : null
          frames.push({
            index: frame.index,
            luma: meanLuma(gray),
            histogram: h,
            motion: levels ? levelsMean(levels) : null,
            motion2: before ? meanAbsDiff(before, gray) : null,
            levels,
            histDiff: prev ? histogramDistance(prev.histogram, h) : null,
            thumb: thumbnail(gray)
          })
        }
        before = prev?.gray
        prev = { gray, histogram: h }
      })
    ).pipe(Effect.as({ range, frames }))
  })
