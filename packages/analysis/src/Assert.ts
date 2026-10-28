import {
  Address,
  type AddressOutOfRange,
  InvalidInput,
  type KymoError,
  type Marker,
  type NotSeekable,
  type Source,
  type Timeline,
  type Track,
  resolveContext
} from "@kymo/core"
import { Effect, Result, Schema } from "effect"
import { type Assertion, type Op, type When, parseAssertion } from "./AssertParse.ts"
import { round } from "./Stats.ts"

export const AssertionResult = Schema.Struct({
  assertion: Schema.String,
  pass: Schema.Boolean,
  /** The deciding value: the first failing sample, or the value that passed; a marker's frame index. */
  observed: Schema.NullOr(Schema.Number),
  /** Where `observed` was read. */
  address: Schema.optionalKey(Schema.String),
  message: Schema.String
})
export type AssertionResult = typeof AssertionResult.Type

/** What assertions are evaluated against. Markers here are added to the Timeline's own. */
export interface AssertContext {
  readonly timeline: Timeline
  readonly tracks: ReadonlyMap<string, Track>
  readonly markers?: ReadonlyArray<Marker>
}

type EvalError = AddressOutOfRange | NotSeekable | InvalidInput

const holds = (op: Op, v: number, target: number): boolean => {
  switch (op) {
    case ">=":
      return v >= target
    case "<=":
      return v <= target
    case ">":
      return v > target
    case "<":
      return v < target
    case "==":
      return Math.abs(v - target) <= 1e-9 * Math.max(1, Math.abs(target))
    case "!=":
      return Math.abs(v - target) > 1e-9 * Math.max(1, Math.abs(target))
  }
}

const WHEN_WORDS = {
  Always: "",
  At: "at",
  By: "by",
  After: "after",
  Before: "before",
  During: "during"
} as const

/** The inclusive frame span a `When` quantifies over, and whether it is a single required frame. */
const spanOf = (
  when: When,
  resolve: (a: Address.Address) => Result.Result<ReadonlyArray<number>, AddressOutOfRange | NotSeekable>,
  frameCount: number
): Result.Result<{ readonly from: number; readonly to: number }, AddressOutOfRange | NotSeekable> => {
  const end = frameCount - 1
  switch (when._tag) {
    case "Always":
      return Result.succeed({ from: 0, to: end })
    case "During":
      return Result.map(resolve(when.range), (ix) => ({ from: ix[0]!, to: ix[ix.length - 1]! }))
    case "At":
      return Result.map(resolve(when.point), (ix) => ({ from: ix[0]!, to: ix[0]! }))
    case "By":
      return Result.map(resolve(when.point), (ix) => ({ from: ix[0]!, to: end }))
    case "After":
      return Result.map(resolve(when.point), (ix) => ({ from: ix[0]! + 1, to: end }))
    case "Before":
      return Result.map(resolve(when.point), (ix) => ({ from: 0, to: ix[0]! - 1 }))
  }
}

/** The tracks a measured box adds (see `trackRegion`). */
const BOX_TRACK = /^box\.(x|y|w|h|confidence)$/

const unknownTrack = (name: string, known: ReadonlyArray<string>) =>
  new InvalidInput({
    message: `There is no track "${name}". Tracks: ${known.length > 0 ? known.join(", ") : "none"}.`,
    hint: BOX_TRACK.test(name)
      ? `Measure it: pass box (CLI --box) with the region as it is at the first frame of the range, e.g. --box 120,80,64,64; then ${name} is a track.`
      : `Use one of those names, e.g. ${known[0] ?? "motion"} >= 0 at 0f.`
  })

/** Evaluate one parsed assertion. Address operands resolve against the Timeline plus the extra markers. */
export const evaluate = (
  assertion: Assertion,
  ctx: AssertContext
): Result.Result<AssertionResult, EvalError> => {
  const markers = [...ctx.timeline.markers, ...(ctx.markers ?? [])]
  const rctx = { ...resolveContext(ctx.timeline), markers }
  const rate = ctx.timeline.rate
  const resolve = (a: Address.Address) => Address.resolve(rctx, a)
  const result = (pass: boolean, observed: number | null, at: number | undefined, message: string) =>
    ({
      assertion: assertion.text,
      pass,
      observed,
      ...(at === undefined ? {} : { address: Address.format(rate, at) }),
      message
    }) satisfies AssertionResult

  if (assertion._tag === "Marker") {
    const marker = markers.find((m) => m.name === assertion.marker)
    if (!marker) {
      const known = markers.map((m) => `@${m.name}`).join(", ") || "none"
      return Result.succeed(
        result(false, null, undefined, `@${assertion.marker} does not exist. Markers: ${known}.`)
      )
    }
    return Result.map(resolve(assertion.where), (ix) => {
      const a = ix[0]!
      const b = ix[ix.length - 1]!
      const i = marker.index
      const pass =
        assertion.relation === "within"
          ? i >= a && i <= b
          : assertion.relation === "at"
            ? i === a
            : assertion.relation === "before"
              ? i < a
              : i > a
      return result(
        pass,
        i,
        i,
        `@${marker.name} is at ${Address.label(rate, i)}, ${pass ? "" : "not "}${assertion.relation} ${assertion.where.text}.`
      )
    })
  }

  const track = ctx.tracks.get(assertion.track)
  if (!track) return Result.fail(unknownTrack(assertion.track, [...ctx.tracks.keys()]))
  const { op, value, when } = assertion
  return Result.map(spanOf(when, resolve, ctx.timeline.frameCount), ({ from, to }) => {
    const where =
      when._tag === "Always"
        ? "anywhere"
        : `${WHEN_WORDS[when._tag]} ${"point" in when ? when.point.text : when.range.text}`
    let firstKnown: number | undefined
    for (let i = Math.max(0, from); i <= to; i++) {
      const v = track.samples[i]
      if (v == null) continue
      firstKnown ??= i
      if (!holds(op, v, value)) {
        return result(
          false,
          round(v, 6),
          i,
          `${track.name} is ${round(v, 6)} at ${Address.label(rate, i)}, which is not ${op} ${value} (${where}).`
        )
      }
    }
    if (firstKnown === undefined) {
      return result(false, null, from <= to ? from : undefined, `${track.name} has no known value ${where}.`)
    }
    const v = track.samples[firstKnown]!
    const stays = when._tag === "At" ? "" : when._tag === "By" ? " and stays there" : " on every known frame"
    return result(
      true,
      round(v, 6),
      firstKnown,
      `${track.name} is ${op} ${value}${stays} (${where}); ${round(v, 6)} at ${Address.label(rate, firstKnown)}.`
    )
  })
}

export interface AssertInput {
  readonly source: Source
  readonly assertions: ReadonlyArray<string>
  /** Tracks not on the source, such as `motion` or a tracked region's `box.x`. */
  readonly tracks?: ReadonlyArray<Track>
  /** Markers not on the source, such as `cut1` or `peak1`. */
  readonly markers?: ReadonlyArray<Marker>
}

/** Parse every assertion first (so one typo fails fast), fetch the tracks they name, then evaluate. */
export const runAssertions = (input: AssertInput): Effect.Effect<ReadonlyArray<AssertionResult>, KymoError> =>
  Effect.gen(function* () {
    const parsed: Array<Assertion> = []
    for (const text of input.assertions) parsed.push(yield* Effect.fromResult(parseAssertion(text)))
    const tracks = new Map((input.tracks ?? []).map((t) => [t.name, t]))
    const available = [...new Set([...tracks.keys(), ...input.source.timeline.tracks.map((t) => t.name)])]
    for (const a of parsed) {
      if (a._tag !== "Compare" || tracks.has(a.track)) continue
      if (!available.includes(a.track)) return yield* Effect.fail(unknownTrack(a.track, available))
      tracks.set(a.track, yield* input.source.track(a.track))
    }
    const ctx: AssertContext = { timeline: input.source.timeline, tracks, markers: input.markers ?? [] }
    const out: Array<AssertionResult> = []
    for (const a of parsed) out.push(yield* Effect.fromResult(evaluate(a, ctx)))
    return out
  })
