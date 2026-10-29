/**
 * Frames of two sources showing the same moment. An address is read on one source's clock (A's, or
 * B's when it starts with B's handle), turned into a moment, and matched to the other source's frame
 * at that moment. Sources on the same constant clock pair by index, exactly.
 *
 * A source's `offset` (set with `open --offset`) is how many frames it runs late: frame i of a source
 * with offset k shows moment i − k. So A's frame i pairs with B's frame i − offset(A) + offset(B).
 * Every view that pairs frames gets its pairs here, so none can ignore an offset.
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
  fpsOf,
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

/** Frames `t` runs late; 0 unless set with `open --offset`. */
export const offsetOf = (t: Timeline): number => t.offset ?? 0

/** `+6f`, `-3f` or `0f`: an offset as compare reports it. */
const formatOffset = (t: Timeline): string => {
  const k = offsetOf(t)
  return `${k > 0 ? "+" : ""}${k}f`
}

/** `clip1 vs clip2`, naming any offset applied: `clip1 vs clip2 (clip2 +6f)`. */
export const pairTitle = (a: Timeline, b: Timeline): string => {
  const shifted = [a, b].filter((t) => offsetOf(t) !== 0)
  const offsets = shifted.map((t) => `${t.handle} ${formatOffset(t)}`).join(", ")
  return `${a.handle} vs ${b.handle}${shifted.length === 0 ? "" : ` (${offsets})`}`
}

/** The frame of `to` showing the moment frame `index` of `from` shows; may lie outside `to`. */
const partner = (from: Timeline, to: Timeline, index: number): number => {
  if (sameClock(from, to)) return index - offsetOf(from) + offsetOf(to)
  // An offset counts frames at the source's (average) rate.
  const t = secondsAt(from.rate, index) - offsetOf(from) / fpsOf(from.rate) + offsetOf(to) / fpsOf(to.rate)
  return indexAtSeconds(to.rate, t)
}

const inside = (t: Timeline, index: number): boolean => index >= 0 && index < t.frameCount

/** `0f..05f`, or one address when the run is one frame. */
const span = (t: Timeline, first: number, last: number): string =>
  first === last
    ? Address.format(t.rate, first)
    : `${Address.format(t.rate, first)}..${Address.format(t.rate, last)}`

/** Contiguous runs of indices on `t`'s clock, e.g. `0f..05f, 01s10f`. */
const spans = (t: Timeline, indices: ReadonlyArray<number>): string => {
  const runs: Array<[number, number]> = []
  for (const i of indices) {
    const last = runs.at(-1)
    if (last !== undefined && last[1] === i - 1) last[1] = i
    else runs.push([i, i])
  }
  return runs.map(([x, y]) => span(t, x, y)).join(", ")
}

/** Which offsets moved the pairing, for messages: "" when neither source has one. */
const shiftedBy = (a: Timeline, b: Timeline): string => {
  const shifted = [a, b].filter((t) => offsetOf(t) !== 0)
  return shifted.length === 0
    ? ""
    : ` with ${shifted.map((t) => `${t.handle}'s offset of ${formatOffset(t)}`).join(" and ")}`
}

/** The frames of `anchor` that `other` has a frame for, as a range on `anchor`'s clock. */
const overlap = (anchor: Timeline, other: Timeline): string | undefined => {
  const both: Array<number> = []
  for (let i = 0; i < anchor.frameCount; i++) if (inside(other, partner(anchor, other, i))) both.push(i)
  const [first, last] = [both[0], both.at(-1)]
  if (first === undefined || last === undefined) return undefined
  return span(anchor, first, last)
}

/** The frame of `to` on screen when frame `index` of `from` is, failing when `to` has no frame then. */
const sameMoment = (
  from: Timeline,
  to: Timeline,
  index: number,
  text: string
): Effect.Effect<FrameIndex, AddressOutOfRange> => {
  const other = partner(from, to, index)
  if (inside(to, other)) return Effect.succeed(frameIndex(other))
  const shift = shiftedBy(from, to)
  const both = overlap(from, to)
  return Effect.fail(
    new AddressOutOfRange({
      message:
        shift === ""
          ? `${text} is ${Address.format(from.rate, index)} on ${from.handle} (${seconds(secondsAt(from.rate, index))}), but ${to.handle} is ${seconds(to.durationSeconds)} long.`
          : `${text} is ${Address.format(from.rate, index)} on ${from.handle}${shift}, which would be ${to.handle}'s frame #${other}, but ${to.handle} has frames #0 to #${to.frameCount - 1}.`,
      hint:
        both === undefined
          ? `${from.handle} and ${to.handle} share no moment${shift}; check the offsets with probe, or set them again with kymo open --offset.`
          : `Use a moment both sources have: ${both} on ${from.handle}${shift}.`
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

/** Every frame of A that B also has a frame for, paired, and a warning naming A's frames left out. */
export const allPairs = (
  a: Timeline,
  b: Timeline
): Effect.Effect<
  { readonly pairs: ReadonlyArray<FramePair>; readonly left: string | undefined },
  AddressOutOfRange
> => {
  const pairs: Array<FramePair> = []
  const unpaired: Array<number> = []
  for (let i = 0; i < a.frameCount; i++) {
    const j = partner(a, b, i)
    if (inside(b, j)) pairs.push({ a: frameIndex(i), b: frameIndex(j) })
    else unpaired.push(i)
  }
  const shift = shiftedBy(a, b)
  if (pairs.length === 0)
    return Effect.fail(
      new AddressOutOfRange({
        message: `${a.handle} and ${b.handle} share no moment${shift}, so there is nothing to compare.`,
        hint: "Check the offsets with probe, or set them again with kymo open --offset."
      })
    )
  const left =
    unpaired.length === 0
      ? undefined
      : `${a.handle} ${spans(a, unpaired)} (${unpaired.length} frame${unpaired.length === 1 ? "" : "s"}) ha${unpaired.length === 1 ? "s" : "ve"} no ${b.handle} frame at the same moment${shift}, so ${unpaired.length === 1 ? "it was" : "they were"} not compared.`
  return Effect.succeed({ pairs, left })
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
