import { InvalidInput } from "@kymo/core"
import { Result, Schema } from "effect"

/** Smallest custom long edge: below this a single labelled frame no longer fits. */
export const MIN_TARGET_EDGE = 320
/** Largest custom long edge kymo will render. */
export const MAX_TARGET_EDGE = 8000
/** Smallest custom token budget: one 320 px labelled frame. */
export const MIN_TARGET_TOKENS = 64

/**
 * Most bytes one encoded image may take. APIs cap an image at 5 MB of base64, which is 3.75 MB of
 * file; an image over budget is re-encoded with a palette, then scaled down, until it fits.
 */
export const DEFAULT_MAX_BYTES = 3_750_000
/** Smallest custom byte budget: a 320 px sheet of noise still fits after scaling. */
export const MIN_TARGET_BYTES = 50_000

const CustomFields = {
  maxEdge: Schema.Int.check(Schema.isBetween({ minimum: MIN_TARGET_EDGE, maximum: MAX_TARGET_EDGE })),
  maxTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_TARGET_TOKENS)),
  maxBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_TARGET_BYTES)))
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
  readonly maxBytes?: number
}): Result.Result<Target, InvalidInput> =>
  Result.mapError(
    decodeCustom({ _tag: "custom", ...budget }),
    () =>
      new InvalidInput({
        message: `A custom target of ${budget.maxEdge} px / ${budget.maxTokens} tokens${budget.maxBytes === undefined ? "" : ` / ${budget.maxBytes} bytes`} is out of range.`,
        hint: `maxEdge is an integer from ${MIN_TARGET_EDGE} to ${MAX_TARGET_EDGE}; maxTokens is an integer of at least ${MIN_TARGET_TOKENS}; maxBytes, if given, at least ${MIN_TARGET_BYTES}.`
      })
  )

export interface Budget {
  /** Longest side of the image in pixels. */
  readonly maxEdge: number
  /** Visual tokens (see `visualTokens`). */
  readonly maxTokens: number
  /** Bytes of the encoded file. */
  readonly maxBytes: number
}

export const targetBudget = (target: Target): Budget => {
  switch (target._tag) {
    case "high-res":
      return { maxEdge: 2576, maxTokens: 4784, maxBytes: DEFAULT_MAX_BYTES }
    case "standard":
      return { maxEdge: 1568, maxTokens: 1568, maxBytes: DEFAULT_MAX_BYTES }
    case "custom":
      return {
        maxEdge: target.maxEdge,
        maxTokens: target.maxTokens,
        maxBytes: target.maxBytes ?? DEFAULT_MAX_BYTES
      }
  }
}
