import { Address, FrameIndex, FramesView, InvalidInput } from "@kymo/core"
import { Result, Schema } from "effect"
import type { FrameRange } from "./Range.ts"

export const RULES = [
  "duplicate-frames",
  "dropped-frames",
  "flicker",
  "black-frames",
  "safe-area",
  "non-monotonic"
] as const
export const RuleName = Schema.Literals(RULES)
export type RuleName = typeof RuleName.Type

export const Severity = Schema.Literals(["error", "warning", "info"])
export type Severity = typeof Severity.Type

/** How to look at a finding: always a real `kymo_frames` view. */
export const SuggestView = FramesView
export type SuggestView = FramesView

export const Finding = Schema.Struct({
  rule: RuleName,
  severity: Severity,
  address: Schema.String,
  index: FrameIndex,
  /** Range address when the finding covers more than one frame, e.g. `02s10f..02s14f`. */
  span: Schema.optionalKey(Schema.String),
  message: Schema.String,
  /** The next call that shows the problem. */
  suggest: Schema.Struct({
    tool: Schema.Literal("kymo_frames"),
    at: Schema.Array(Schema.String),
    view: SuggestView
  })
})
export type Finding = typeof Finding.Type

export const parseRules = (
  names: ReadonlyArray<string>
): Result.Result<ReadonlyArray<RuleName>, InvalidInput> => {
  const unknown = names.filter((n) => !(RULES as ReadonlyArray<string>).includes(n))
  return unknown.length === 0
    ? Result.succeed(RULES.filter((r) => names.includes(r)))
    : Result.fail(
        new InvalidInput({
          message: `Unknown rule${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Valid rules: ${RULES.join(", ")}.`,
          hint: `Pick from the valid rules, e.g. rules=flicker,black-frames.`
        })
      )
}

/** Spans up to this many frames are suggested frame by frame; longer ones as a stepped range. */
const MAX_LISTED = 6
/** About how many frames a stepped suggestion shows. */
const STEPPED_FRAMES = 12

/**
 * The addresses to look at a finding: every frame of the span plus one neighbour each side, or for a
 * long span a stepped range over it plus its last frame and the `context` frames.
 */
const suggestAt = (
  range: FrameRange,
  index: number,
  last: number,
  context: ReadonlyArray<number>
): Array<string> => {
  const inside = (i: number) => i >= range.first && i <= range.last
  const points = [index, last, ...context].filter(inside)
  const a = Math.max(range.first, Math.min(...points) - 1)
  const b = Math.min(range.last, Math.max(...points) + 1)
  const fmt = (i: number) => range.ref(i).address
  if (b - a + 1 <= MAX_LISTED + 2) return Array.from({ length: b - a + 1 }, (_, k) => fmt(a + k))
  const step = Math.ceil((b - a) / (STEPPED_FRAMES - 1))
  const extra = [...new Set([index, last, b, ...context].filter((i) => inside(i) && (i - a) % step !== 0))]
  return [Address.formatSpan(range.rate, a, b, step), ...extra.sort((x, y) => x - y).map(fmt)]
}

/**
 * Build a finding at `index` (optionally running to `last`). The suggested frames are derived from the
 * span, so no rule can suggest a view that skips frames of its own finding; `context` adds frames
 * outside the span that explain it (where a reversed value peaked, say).
 */
export const finding = (
  range: FrameRange,
  fields: {
    readonly rule: RuleName
    readonly severity: Severity
    readonly index: number
    readonly last?: number
    readonly message: string
    readonly view: SuggestView
    readonly context?: ReadonlyArray<number>
  }
): Finding => {
  const ref = range.ref(fields.index)
  const at = suggestAt(
    range,
    fields.index,
    Math.max(fields.index, fields.last ?? fields.index),
    fields.context ?? []
  )
  return {
    rule: fields.rule,
    severity: fields.severity,
    address: ref.address,
    index: ref.index,
    ...(fields.last !== undefined && fields.last > fields.index
      ? { span: range.spanText(fields.index, fields.last) }
      : {}),
    message: fields.message,
    suggest: { tool: "kymo_frames", at, view: fields.view }
  }
}
