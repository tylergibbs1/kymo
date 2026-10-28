/** Turning address text into frames of one opened source. Every operation resolves through here. */
import { FrameRange } from "@kymo/analysis"
import {
  Address,
  AddressParseError,
  type FrameIndex,
  InvalidInput,
  type KymoError,
  type Timeline,
  frameIndex,
  resolveContext
} from "@kymo/core"
import { Effect, Result } from "effect"

const parse = (timeline: Timeline, text: string): Effect.Effect<Address.Address, KymoError> =>
  Effect.flatMap(Address.parseEffect(text), (address) =>
    address.handle === undefined || address.handle === timeline.handle
      ? Effect.succeed(address)
      : Effect.fail(
          new InvalidInput({
            message: `${text} names source ${address.handle}, but this call is about ${timeline.handle}.`,
            hint: `Drop the handle (${text.slice(address.handle.length + 1)}) or pass source=${address.handle}.`
          })
        )
  )

/** Every frame the addresses name, in time order, each once. */
export const resolveAddresses = (
  timeline: Timeline,
  texts: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<FrameIndex>, KymoError> =>
  Effect.gen(function* () {
    const ctx = resolveContext(timeline)
    const out = new Set<number>()
    for (const text of texts) {
      const address = yield* parse(timeline, text)
      for (const i of yield* Effect.fromResult(Address.resolve(ctx, address))) out.add(i)
    }
    return [...out].sort((a, b) => a - b).map(frameIndex)
  })

/** Every frame of a (possibly stepped) range, or of the whole source when no range is given. */
export const resolveSpan = (
  timeline: Timeline,
  range: string | undefined
): Effect.Effect<ReadonlyArray<FrameIndex>, KymoError> =>
  range === undefined
    ? timeline.frameCount > 0
      ? Effect.succeed(Array.from({ length: timeline.frameCount }, (_, i) => frameIndex(i)))
      : Effect.fail(
          new InvalidInput({
            message: `${timeline.handle} has no frames yet.`,
            hint: "Open a source with at least one frame."
          })
        )
    : resolveAddresses(timeline, [range])

/** A contiguous analysis range, or the whole source. */
export const analysisRange = (
  timeline: Timeline,
  range: string | undefined
): Effect.Effect<FrameRange, KymoError> =>
  range === undefined
    ? FrameRange.whole(timeline)
    : Effect.flatMap(parse(timeline, range), (address) =>
        FrameRange.parse(
          timeline,
          address.handle === undefined ? range : range.slice(address.handle.length + 1)
        )
      )

/** Check address text parses, without a Timeline, so bad input fails before a source is opened. */
export const checkSyntax = (texts: ReadonlyArray<string>): Effect.Effect<void, AddressParseError> =>
  Effect.forEach(texts, (text) => Effect.fromResult(Result.map(Address.parse(text), () => undefined)), {
    discard: true
  })
