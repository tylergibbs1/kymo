import {
  Address,
  type AddressOutOfRange,
  type AddressParseError,
  type FrameRef,
  type FrameIndex,
  InvalidInput,
  type NotSeekable,
  type Rate,
  type Timeline,
  frameIndex,
  resolveContext,
  secondsAt
} from "@kymo/core"
import { Effect } from "effect"

/**
 * A contiguous, inclusive, non-empty run of frames on one clock. Only built by
 * `whole` or `parse`, so every FrameRange in the program is in bounds.
 */
export class FrameRange {
  readonly rate: Rate
  readonly first: FrameIndex
  readonly last: FrameIndex
  /** Frames on the whole Timeline; Track samples have this length. */
  readonly frameCount: number

  private constructor(rate: Rate, first: FrameIndex, last: FrameIndex, frameCount: number) {
    this.rate = rate
    this.first = first
    this.last = last
    this.frameCount = frameCount
  }

  get count(): number {
    return this.last - this.first + 1
  }

  indices(): ReadonlyArray<FrameIndex> {
    return Array.from({ length: this.count }, (_, k) => frameIndex(this.first + k))
  }

  ref(index: number): FrameRef {
    return frameRef(this.rate, index)
  }

  /** The address text for a span of this clock, e.g. `01s10f..02s`. */
  spanText(from: number, to: number): string {
    return `${Address.format(this.rate, from)}..${Address.format(this.rate, to)}`
  }

  /** A sub-range, clamped to this one. Callers pass indices they derived from this range. */
  clamp(first: number, last: number): FrameRange {
    const a = Math.max(this.first, Math.min(first, last))
    const b = Math.min(this.last, Math.max(first, last))
    return new FrameRange(this.rate, frameIndex(a), frameIndex(b), this.frameCount)
  }

  static whole(timeline: Timeline): Effect.Effect<FrameRange, InvalidInput> {
    return timeline.frameCount > 0
      ? Effect.succeed(
          new FrameRange(
            timeline.rate,
            frameIndex(0),
            frameIndex(timeline.frameCount - 1),
            timeline.frameCount
          )
        )
      : Effect.fail(
          new InvalidInput({
            message: `${timeline.handle} has no frames to analyse.`,
            hint: "Open a source with at least one frame, or wait for a live buffer to fill."
          })
        )
  }

  /** Parse address text like `2s..4s` or `@cut1..-1f` into a contiguous range. A single point is a one-frame range. */
  static parse(
    timeline: Timeline,
    text: string
  ): Effect.Effect<FrameRange, AddressParseError | AddressOutOfRange | NotSeekable | InvalidInput> {
    return Effect.gen(function* () {
      const address = yield* Address.parseEffect(text)
      if (address.spec._tag === "Range" && address.spec.step !== undefined) {
        const plain = address.text.slice(0, address.text.lastIndexOf(":"))
        return yield* Effect.fail(
          new InvalidInput({
            message: `Analysis ranges are contiguous; "${text}" has a step.`,
            hint: `Drop the step: ${plain}`
          })
        )
      }
      const indices = yield* Effect.fromResult(Address.resolve(resolveContext(timeline), address))
      const first = indices[0]!
      const last = indices[indices.length - 1]!
      return new FrameRange(timeline.rate, first, last, timeline.frameCount)
    })
  }
}

export const frameRef = (rate: Rate, index: number): FrameRef => ({
  address: Address.format(rate, index),
  index: frameIndex(index),
  t: secondsAt(rate, frameIndex(index))
})
