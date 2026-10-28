import {
  Address,
  AddressOutOfRange,
  type DecodedFrame,
  type FrameIndex,
  type FrameRef,
  InvalidInput,
  type KymoError,
  type Size,
  type Source,
  type Timeline
} from "@kymo/core"
import { Effect, Stream } from "effect"

/** Pixel size of a source's frames; sources without pixels cannot be drawn. */
export const frameSize = (source: Source): Effect.Effect<Size, InvalidInput> => {
  const size = source.timeline.size
  return size !== null && size.width > 0 && size.height > 0
    ? Effect.succeed(size)
    : Effect.fail(
        new InvalidInput({
          message: `${source.timeline.handle} is a ${source.timeline.kind} source with no pixels to draw.`,
          hint: "Plot its tracks instead."
        })
      )
}

/** Refuse empty lists and indices the source does not have. */
export const checkFrames = (
  source: Source,
  frames: ReadonlyArray<FrameIndex>,
  limits: { readonly min?: number; readonly max?: number } = {}
): Effect.Effect<void, InvalidInput | AddressOutOfRange> => {
  const { handle, frameCount, rate } = source.timeline
  const min = limits.min ?? 1
  if (frames.length < min || (limits.max !== undefined && frames.length > limits.max))
    return Effect.fail(
      new InvalidInput({
        message: `This view takes ${limits.max === undefined ? `at least ${min}` : `${min} to ${limits.max}`} frames, not ${frames.length}.`,
        hint: "Pass a range with a step, like 2s..4s:5f."
      })
    )
  const bad = frames.find((i) => i >= frameCount)
  return bad === undefined
    ? Effect.void
    : Effect.fail(
        new AddressOutOfRange({
          message: `#${bad} is past the end of ${handle} (duration ${Address.format(rate, frameCount)}).`,
          hint: `Valid frames are 0f (#0) to ${Address.format(rate, frameCount - 1)} (#${frameCount - 1}).`
        })
      )
}

/** Decode frames in the order given, at most `maxEdge` on the long side. */
export const readFrames = (
  source: Source,
  indices: ReadonlyArray<FrameIndex>,
  maxEdge: number
): Effect.Effect<ReadonlyArray<DecodedFrame>, KymoError> =>
  Stream.runCollect(source.readFrames(indices, { maxEdge }))

export const frameRef = (timeline: Timeline, frame: DecodedFrame): FrameRef => ({
  address: Address.format(timeline.rate, frame.index),
  index: frame.index,
  t: frame.t
})

/** `08s10f #250`, or `clip1@08s10f #250` with the handle. */
export const frameLabel = (timeline: Timeline, index: number, withHandle: boolean): string =>
  `${withHandle ? `${timeline.handle}@` : ""}${Address.label(timeline.rate, index)}`

/** Span of a list in reading order: `0f-08s10f`. */
export const spanOf = (timeline: Timeline, indices: ReadonlyArray<number>): string =>
  Address.spanName(timeline.rate, indices[0]!, indices[indices.length - 1]!)

/** File-name-safe form of free text such as a track name. */
export const fileSafe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_")
