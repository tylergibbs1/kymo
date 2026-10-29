/** Measuring a region named by `box`: the one path track, check and frames take, so they agree. */
import {
  type Box,
  type BoxChange,
  type FrameRange,
  type RegionTrack,
  type Within,
  boxChange,
  parseBox,
  trackRegion
} from "@kymo/analysis"
import { Address, InvalidInput, type KymoError, type Size, type Source } from "@kymo/core"
import { Effect } from "effect"

/** A box that fits any frame of `size`, for hints that must work as given. */
export const exampleBox = (size: Size): string =>
  [0.4 * size.width, 0.4 * size.height, 0.2 * size.width, 0.2 * size.height]
    .map((v) => Math.max(1, Math.round(v)))
    .join(",")

/** How to find a box: look at the range's first frame on a grid. */
export const findBoxHint = (source: Source, range: FrameRange, style: Address.LabelStyle): string =>
  `find it with kymo frames ${source.timeline.handle} --at ${Address.styledAddress(range.rate, range.first, style)} --view grid`

/** `box` text parsed against the source's frame size. */
export const boxOn = (source: Source, box: string): Effect.Effect<Box, KymoError> =>
  Effect.gen(function* () {
    const { timeline } = source
    if (timeline.size === null)
      return yield* Effect.fail(
        new InvalidInput({
          message: `${timeline.handle} has no pixels to measure a box on.`,
          hint: "Drop box and use the source's own tracks."
        })
      )
    return yield* Effect.fromResult(parseBox(box, timeline.size))
  })

/** Follow `box` (source pixels, as it is at `anchor`, default the range's first frame) through the range. */
export const measureBox = (
  source: Source,
  range: FrameRange,
  box: string,
  anchor: number = range.first
): Effect.Effect<RegionTrack, KymoError> =>
  Effect.flatMap(boxOn(source, box), (b) => trackRegion(source, range, b, { anchor }))

/** Visible change inside `box`, a fixed place on screen, through the range; `within` times it. */
export const measureChange = (
  source: Source,
  range: FrameRange,
  box: string,
  within?: Within
): Effect.Effect<BoxChange, KymoError> =>
  Effect.flatMap(boxOn(source, box), (b) =>
    boxChange(source, range, b, within === undefined ? {} : { within })
  )
