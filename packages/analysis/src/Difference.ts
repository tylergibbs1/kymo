import { Address, type FrameIndex, FrameRef, type KymoError, type Source } from "@kymo/core"
import { Effect, Schema, Stream } from "effect"
import { type Gray, meanAbsDiff, toGray } from "./Pixels.ts"
import { frameRef } from "./Range.ts"
import { round } from "./Stats.ts"

/** Compare reads frames this big: small enough to be quick, big enough that a changed label survives. */
export const COMPARE_MAX_EDGE = 480

/** A pixel whose luma moved more than this (0..1) changed; below it is encoding noise. */
export const NOISE = 0.08

/** A pair counts as changed when more than this fraction of its pixels changed (0.1%: a short label on 720p). */
export const CHANGED_FRACTION = 0.001

export const FrameDifference = Schema.Struct({
  ...FrameRef.fields,
  bAddress: Schema.String.annotate({ description: "B's frame compared with this one, in B's own address." }),
  bIndex: Schema.Int,
  meanDiff: Schema.Number.annotate({
    description: "Mean absolute luma difference over the whole frame, 0..1."
  }),
  changedFraction: Schema.Number.annotate({
    description: `Fraction of pixels whose luma differs by more than ${NOISE} (encoding noise is below), 0..1. Does not depend on frame size.`
  }),
  changedMean: Schema.Number.annotate({
    description: "Mean absolute luma difference over the changed pixels only, 0..1; 0 when none changed."
  })
})
export type FrameDifference = typeof FrameDifference.Type

/** One frame of A and the frame of B showing the same moment. */
export interface FramePair {
  readonly a: FrameIndex
  readonly b: FrameIndex
}

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

const changedPixels = (a: Gray, b: Gray): { readonly fraction: number; readonly mean: number } => {
  let count = 0
  let sum = 0
  const limit = NOISE * 255
  for (let k = 0; k < a.data.length; k++) {
    const d = Math.abs(a.data[k]! - b.data[k]!)
    if (d > limit) {
      count++
      sum += d
    }
  }
  return { fraction: count / a.data.length, mean: count === 0 ? 0 : sum / count / 255 }
}

/**
 * How different two sources look at paired frames, read at `COMPARE_MAX_EDGE`: the whole-frame mean,
 * and the fraction and strength of the pixels that changed beyond noise, so a small change in a big
 * frame is not averaged away. B is resampled onto A's grid when their sizes differ.
 */
export const frameDifferences = (
  a: Source,
  b: Source,
  pairs: ReadonlyArray<FramePair>
): Effect.Effect<ReadonlyArray<FrameDifference>, KymoError> =>
  Effect.gen(function* () {
    const read = (s: Source, indices: ReadonlyArray<FrameIndex>) =>
      Stream.runCollect(s.readFrames(indices, { maxEdge: COMPARE_MAX_EDGE }))
    const fromA = yield* read(
      a,
      pairs.map((p) => p.a)
    )
    const fromB = yield* read(
      b,
      pairs.map((p) => p.b)
    )
    return fromA.map((fa, k) => {
      const ga = toGray(fa.image)
      const gb = resample(toGray(fromB[k]!.image), ga.width, ga.height)
      const changed = changedPixels(ga, gb)
      const bIndex = pairs[k]!.b
      return {
        ...frameRef(a.timeline.rate, fa.index),
        bAddress: Address.format(b.timeline.rate, bIndex),
        bIndex,
        meanDiff: round(meanAbsDiff(ga, gb), 6),
        changedFraction: round(changed.fraction, 6),
        changedMean: round(changed.mean, 6)
      }
    })
  })

/** Whether a pair changed beyond noise. */
export const isChanged = (d: FrameDifference): boolean => d.changedFraction > CHANGED_FRACTION
