import { FrameIndex, FramesView, InvalidInput } from "@kymo/core"
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

/** Build a finding at `index` (optionally running to `last`), with a suggestion clamped to the range. */
export const finding = (
  range: FrameRange,
  fields: {
    readonly rule: RuleName
    readonly severity: Severity
    readonly index: number
    readonly last?: number
    readonly message: string
    readonly view: SuggestView
    readonly at: ReadonlyArray<number>
  }
): Finding => {
  const ref = range.ref(fields.index)
  const at = [...new Set(fields.at.filter((i) => i >= range.first && i <= range.last))].sort((a, b) => a - b)
  return {
    rule: fields.rule,
    severity: fields.severity,
    address: ref.address,
    index: ref.index,
    ...(fields.last !== undefined && fields.last > fields.index
      ? { span: range.spanText(fields.index, fields.last) }
      : {}),
    message: fields.message,
    suggest: { tool: "kymo_frames", at: at.map((i) => range.ref(i).address), view: fields.view }
  }
}
