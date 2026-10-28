/** Measuring a region named by `box`: the one path track and check both take, so they agree. */
import { type FrameRange, type RegionTrack, parseBox, trackRegion } from "@kymo/analysis"
import { Address, InvalidInput, type KymoError, type Size, type Source } from "@kymo/core"
import { Effect } from "effect"

/** A box that fits any frame of `size`, for hints that must work as given. */
export const exampleBox = (size: Size): string =>
  [0.4 * size.width, 0.4 * size.height, 0.2 * size.width, 0.2 * size.height]
    .map((v) => Math.max(1, Math.round(v)))
    .join(",")

/** How to find a box: look at the range's first frame on a grid. */
export const findBoxHint = (source: Source, range: FrameRange): string =>
  `find it with kymo frames ${source.timeline.handle} --at ${Address.format(range.rate, range.first)} --view grid`

/** Follow `box` (source pixels, as it is at the range's first frame) through the range. */
export const measureBox = (
  source: Source,
  range: FrameRange,
  box: string
): Effect.Effect<RegionTrack, KymoError> =>
  Effect.gen(function* () {
    const { timeline } = source
    if (timeline.size === null)
      return yield* Effect.fail(
        new InvalidInput({
          message: `${timeline.handle} has no pixels to measure a box on.`,
          hint: "Drop box and use the source's own tracks."
        })
      )
    return yield* trackRegion(source, range, yield* Effect.fromResult(parseBox(box, timeline.size)))
  })
