/**
 * Frames of two sources showing the same moment. An address is read on one source's clock (A's, or
 * B's when it starts with B's handle), turned into seconds, and matched to the other source's frame
 * at that time. Sources on the same constant clock pair by index, exactly.
 */
import type { FramePair } from "@kymo/analysis"
import {
  Address,
  AddressOutOfRange,
  type FrameIndex,
  InvalidInput,
  type KymoError,
  type Timeline,
  clockOf,
  frameIndex,
  indexAtSeconds,
  resolveContext,
  secondsAt
} from "@kymo/core"
import { Effect } from "effect"

const sameClock = (a: Timeline, b: Timeline): boolean =>
  clockOf(a.rate) === undefined &&
  clockOf(b.rate) === undefined &&
  a.rate.num * b.rate.den === b.rate.num * a.rate.den

const seconds = (t: number): string => `${Math.round(t * 1000) / 1000}s`

/** The frame of `to` on screen when frame `index` of `from` is, failing when `to` has no frame then. */
const sameMoment = (
  from: Timeline,
  to: Timeline,
  index: number,
  text: string
): Effect.Effect<FrameIndex, AddressOutOfRange> => {
  const t = secondsAt(from.rate, index)
  const other = sameClock(from, to) ? index : indexAtSeconds(to.rate, t)
  if (other >= 0 && other < to.frameCount) return Effect.succeed(frameIndex(other))
  const last = to.frameCount - 1
  return Effect.fail(
    new AddressOutOfRange({
      message: `${text} is ${Address.format(from.rate, index)} on ${from.handle} (${seconds(t)}), but ${to.handle} is ${seconds(to.durationSeconds)} long.`,
      hint: `Use a time both sources have: ${to.handle}'s last frame is ${Address.format(to.rate, last)} (#${last}, ${seconds(secondsAt(to.rate, last))}).`
    })
  )
}

/** One address on whichever source it names, as pairs. */
const pairsOf = (a: Timeline, b: Timeline, text: string): Effect.Effect<Array<FramePair>, KymoError> =>
  Effect.gen(function* () {
    const address = yield* Address.parseEffect(text)
    const onB = address.handle !== undefined && address.handle === b.handle && address.handle !== a.handle
    if (address.handle !== undefined && address.handle !== a.handle && !onB)
      return yield* new InvalidInput({
        message: `${text} names source ${address.handle}, but this compare is about ${a.handle} and ${b.handle}.`,
        hint: `Prefix an address with ${b.handle}@ to read it on ${b.handle}'s clock, or drop the handle to read it on ${a.handle}'s.`
      })
    const [anchor, other] = onB ? [b, a] : [a, b]
    const indices = yield* Effect.fromResult(Address.resolve(resolveContext(anchor), address))
    return yield* Effect.forEach(indices, (i) =>
      Effect.map(sameMoment(anchor, other, i, text), (j) => (onB ? { a: j, b: i } : { a: i, b: j }))
    )
  })

/** Every pair the addresses name, ordered by A's frame then B's, each once. */
export const resolvePairs = (
  a: Timeline,
  b: Timeline,
  texts: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<FramePair>, KymoError> =>
  Effect.map(
    Effect.forEach(texts, (text) => pairsOf(a, b, text)),
    (lists) => {
      const unique = new Map(lists.flat().map((p) => [`${p.a}:${p.b}`, p]))
      return [...unique.values()].sort((x, y) => x.a - y.a || x.b - y.b)
    }
  )

/** Every frame of A that B also has a frame for, paired. */
export const allPairs = (a: Timeline, b: Timeline): ReadonlyArray<FramePair> => {
  const out: Array<FramePair> = []
  for (let i = 0; i < a.frameCount; i++) {
    const j = sameClock(a, b) ? i : indexAtSeconds(b.rate, secondsAt(a.rate, i))
    if (j >= 0 && j < b.frameCount) out.push({ a: frameIndex(i), b: frameIndex(j) })
  }
  return out
}

/** Why the pairs may be hard to read: different clocks, sizes or shapes. */
export const pairWarnings = (a: Timeline, b: Timeline): Array<string> => {
  const out: Array<string> = []
  if (!sameClock(a, b))
    out.push(
      `${a.handle} (${a.vfr ? "variable, " : ""}${Math.round(a.fps * 1000) / 1000} fps) and ${b.handle} (${b.vfr ? "variable, " : ""}${Math.round(b.fps * 1000) / 1000} fps) run on different clocks; frames are matched by time and each side is labelled with its own address.`
    )
  if (a.size !== null && b.size !== null) {
    const [sa, sb] = [a.size, b.size]
    if (sa.width !== sb.width || sa.height !== sb.height) {
      const aspect = Math.abs(sa.width / sa.height - sb.width / sb.height) > 0.01
      out.push(
        aspect
          ? `${a.handle} is ${sa.width}x${sa.height} and ${b.handle} is ${sb.width}x${sb.height}: different shapes, so diffs stretch ${b.handle} onto ${a.handle} and differ everywhere the picture is reframed.`
          : `${a.handle} is ${sa.width}x${sa.height} and ${b.handle} is ${sb.width}x${sb.height}; diffs scale ${b.handle} to ${a.handle}'s size.`
      )
    }
  }
  return out
}
