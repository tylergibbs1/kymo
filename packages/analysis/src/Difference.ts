import { type FrameIndex, FrameRef, type KymoError, type Source } from "@kymo/core"
import { Effect, Schema, Stream } from "effect"
import { type Gray, meanAbsDiff, toGray } from "./Pixels.ts"
import { frameRef } from "./Range.ts"
import { SCAN_MAX_EDGE } from "./Scan.ts"
import { round } from "./Stats.ts"

export const FrameDifference = Schema.Struct({
  ...FrameRef.fields,
  /** Mean absolute luma difference between the two sources at this frame, 0..1. */
  meanDiff: Schema.Number
})
export type FrameDifference = typeof FrameDifference.Type

/** `g` resampled (nearest neighbour) onto `width` × `height`, so sources of different sizes compare. */
const resample = (g: Gray, width: number, height: number): Gray => {
  if (g.width === width && g.height === height) return g
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(g.height - 1, Math.floor(((y + 0.5) * g.height) / height))
    for (let x = 0; x < width; x++) {
      data[y * width + x] =
        g.data[sy * g.width + Math.min(g.width - 1, Math.floor(((x + 0.5) * g.width) / width))]!
    }
  }
  return { width, height, data }
}

/**
 * How different two sources look at the same frames: mean absolute luma difference per frame,
 * read small (`SCAN_MAX_EDGE`). B is resampled onto A's grid when their sizes differ.
 */
export const frameDifferences = (
  a: Source,
  b: Source,
  indices: ReadonlyArray<FrameIndex>
): Effect.Effect<ReadonlyArray<FrameDifference>, KymoError> =>
  Effect.gen(function* () {
    const read = (s: Source) => Stream.runCollect(s.readFrames(indices, { maxEdge: SCAN_MAX_EDGE }))
    const fromA = yield* read(a)
    const fromB = yield* read(b)
    return fromA.map((fa, k) => {
      const ga = toGray(fa.image)
      const gb = resample(toGray(fromB[k]!.image), ga.width, ga.height)
      return { ...frameRef(a.timeline.rate, fa.index), meanDiff: round(meanAbsDiff(ga, gb), 6) }
    })
  })
