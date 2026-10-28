/**
 * Query-style parameters on an input (`frames/?fps=24`, `synthetic:bounce?frames=90`), decoded with Schema
 * into typed values once, at the boundary.
 */
import { InvalidInput, Rate, type Size } from "@kymo/core"
import { Result, Schema, SchemaTransformation } from "effect"

export interface SplitInput {
  readonly path: string
  readonly params: Readonly<Record<string, string>>
}

/** `path?a=1&b=2` → path and params. A repeated key is an error, not a silent last-wins. */
export const splitQuery = (input: string): Result.Result<SplitInput, InvalidInput> => {
  const q = input.indexOf("?")
  if (q < 0) return Result.succeed({ path: input, params: {} })
  const params: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(input.slice(q + 1))) {
    if (key in params) {
      return Result.fail(
        new InvalidInput({
          message: `"${key}" is given twice in ${input}.`,
          hint: `Give each parameter once, e.g. ${key}=${value}.`
        })
      )
    }
    params[key] = value
  }
  return Result.succeed({ path: input.slice(0, q), params })
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/** An exact rational rate from `30`, `29.97` or `30000/1001`. */
export const parseRational = (text: string): Rate | undefined => {
  const m = /^(\d+)(?:\.(\d+))?(?:\/(\d+))?$/.exec(text)
  if (!m || (m[2] !== undefined && m[3] !== undefined)) return undefined
  const [, whole, frac, over] = m
  let num = Number(whole! + (frac ?? ""))
  let den = (frac === undefined ? 1 : 10 ** frac.length) * Number(over ?? 1)
  if (num <= 0 || den <= 0 || !Number.isSafeInteger(num) || !Number.isSafeInteger(den)) return undefined
  const g = gcd(num, den)
  num /= g
  den /= g
  return Rate.make({ num, den })
}

/** `fps=30`, `fps=29.97` or `fps=30000/1001`, decoded to an exact Rate. */
export const RateParam = Schema.String.check(
  Schema.isPattern(/^(?:\d+(?:\.\d+)?|\d+\/\d+)$/, { expected: "a frame rate like 30, 29.97 or 30000/1001" })
).pipe(
  Schema.decodeTo(
    Rate,
    SchemaTransformation.transform({
      decode: (text) => parseRational(text) ?? { num: 0, den: 1 },
      encode: (r) => `${r.num}/${r.den}`
    })
  )
)

/** `size=640x360`. */
export const SizeParam = Schema.String.check(
  Schema.isPattern(/^\d+x\d+$/, { expected: "a size like 640x360" })
).pipe(
  Schema.decodeTo(
    Schema.Struct({
      width: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 4096 })),
      height: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 4096 }))
    }),
    SchemaTransformation.transform({
      decode: (text): Size => {
        const [w, h] = text.split("x")
        return { width: Number(w), height: Number(h) }
      },
      encode: (s) => `${s.width}x${s.height}`
    })
  )
)

/** A whole number from a query string. */
export const IntParam = (min: number, max: number) =>
  Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: min, maximum: max }))

/** A number from a query string. */
export const NumberParam = (min: number, max: number) =>
  Schema.FiniteFromString.check(Schema.isBetween({ minimum: min, maximum: max }))

/**
 * Decode params with a struct of optional fields. Unknown keys are named explicitly, because a typo
 * like `framez=90` silently falling back to a default is the worst failure for ground truth.
 */
export const decodeParams = <F extends Schema.Struct.Fields>(
  schema: Schema.Struct<F>,
  params: Readonly<Record<string, string>>,
  context: string
): Result.Result<Schema.Struct<F>["Type"], InvalidInput> => {
  const known = Object.keys(schema.fields)
  const unknown = Object.keys(params).filter((k) => !known.includes(k))
  if (unknown.length > 0) {
    return Result.fail(
      new InvalidInput({
        message: `${context} has no parameter ${unknown.map((k) => `"${k}"`).join(", ")}.`,
        hint: known.length > 0 ? `Parameters: ${known.join(", ")}.` : `${context} takes no parameters.`
      })
    )
  }
  return Result.mapError(
    // Param fields are plain string codecs with no decoding services; TS can't see that through a generic F.
    Schema.decodeUnknownResult(schema as unknown as Schema.Codec<Schema.Struct<F>["Type"], unknown>)(params),
    (error) =>
      new InvalidInput({
        message: `Bad parameter in ${context}: ${error.message.replace(/\n\s*/g, " ")}.`,
        hint: `Parameters: ${known.join(", ")}.`
      })
  )
}
