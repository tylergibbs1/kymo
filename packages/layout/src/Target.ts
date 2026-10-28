import { InvalidInput } from "@kymo/core"
import { Result, Schema } from "effect"

/** Smallest custom long edge: below this a single labelled frame no longer fits. */
export const MIN_TARGET_EDGE = 320
/** Largest custom long edge kymo will render. */
export const MAX_TARGET_EDGE = 8000
/** Smallest custom token budget: one 320 px labelled frame. */
export const MIN_TARGET_TOKENS = 64

const CustomFields = {
  maxEdge: Schema.Int.check(Schema.isBetween({ minimum: MIN_TARGET_EDGE, maximum: MAX_TARGET_EDGE })),
  maxTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_TARGET_TOKENS))
}

/** A custom budget. Branded: the only way to get one is through `custom` or decoding `Target`. */
export const CustomTarget = Schema.TaggedStruct("custom", CustomFields).pipe(Schema.brand("CustomTarget"))
export type CustomTarget = typeof CustomTarget.Type

/** Where an image will be viewed: the model's vision limits it must fit inside. */
export const Target = Schema.Union([
  Schema.TaggedStruct("high-res", {}),
  Schema.TaggedStruct("standard", {}),
  CustomTarget
])
export type Target = typeof Target.Type

export const highRes: Target = { _tag: "high-res" }
export const standard: Target = { _tag: "standard" }

const decodeCustom = Schema.decodeUnknownResult(CustomTarget)

/** Validate a custom budget. */
export const customTarget = (budget: {
  readonly maxEdge: number
  readonly maxTokens: number
}): Result.Result<Target, InvalidInput> =>
  Result.mapError(
    decodeCustom({ _tag: "custom", ...budget }),
    () =>
      new InvalidInput({
        message: `A custom target of ${budget.maxEdge} px / ${budget.maxTokens} tokens is out of range.`,
        hint: `maxEdge is an integer from ${MIN_TARGET_EDGE} to ${MAX_TARGET_EDGE}; maxTokens is an integer of at least ${MIN_TARGET_TOKENS}.`
      })
  )

export interface Budget {
  /** Longest side of the image in pixels. */
  readonly maxEdge: number
  /** Visual tokens (see `visualTokens`). */
  readonly maxTokens: number
}

export const targetBudget = (target: Target): Budget => {
  switch (target._tag) {
    case "high-res":
      return { maxEdge: 2576, maxTokens: 4784 }
    case "standard":
      return { maxEdge: 1568, maxTokens: 1568 }
    case "custom":
      return { maxEdge: target.maxEdge, maxTokens: target.maxTokens }
  }
}
