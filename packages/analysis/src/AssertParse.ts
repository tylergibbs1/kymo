/**
 * The assertion language.
 *
 *   assertion := track op number [when address]      #hero.opacity >= 0.99 by 500ms
 *              | "@" marker relation address         @impact within #40..#50
 *   op        := >= | <= | > | < | == | !=
 *   when      := at | by | after | before | during   (during takes a range, the rest a point)
 *   relation  := within | at | before | after        (within takes a range)
 *
 * Every address operand goes through core's Address parser.
 */
import { Address, AddressParseError, InvalidInput } from "@kymo/core"
import { Result } from "effect"

export type Op = ">=" | "<=" | ">" | "<" | "==" | "!="

export type When =
  | { readonly _tag: "Always" }
  /** Holds at that frame. */
  | { readonly _tag: "At"; readonly point: Address.Address }
  /** Holds from that frame to the end: reached by then and stays. */
  | { readonly _tag: "By"; readonly point: Address.Address }
  /** Holds on every frame after it. */
  | { readonly _tag: "After"; readonly point: Address.Address }
  /** Holds on every frame before it. */
  | { readonly _tag: "Before"; readonly point: Address.Address }
  /** Holds on every frame of the range. */
  | { readonly _tag: "During"; readonly range: Address.Address }

export type Relation = "within" | "at" | "before" | "after"

export type Assertion =
  | {
      readonly _tag: "Compare"
      readonly text: string
      readonly track: string
      readonly op: Op
      readonly value: number
      readonly when: When
    }
  | {
      readonly _tag: "Marker"
      readonly text: string
      readonly marker: string
      readonly relation: Relation
      readonly where: Address.Address
    }

const EXAMPLES =
  "e.g. `box.x <= 600 at 1s`, `#hero.opacity >= 0.99 by 500ms`, `box.change == 0 after @settle` or `@impact within #40..#50`"

const TRACK = String.raw`[#.]?[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*`
const NUMBER = String.raw`-?(?:\d+(?:\.\d*)?|\.\d+)`
const COMPARE = new RegExp(String.raw`^(${TRACK})\s*(>=|<=|==|!=|>|<)\s*(${NUMBER})(?:\s+(\S+)\s+(\S+))?$`)
const MARKER = /^@([A-Za-z_]\w*)\s+(\S+)\s+(\S+)$/
const WHENS = ["at", "by", "after", "before", "during"] as const
const RELATIONS = ["within", "at", "before", "after"] as const

const invalid = (text: string, why: string, hint: string) =>
  Result.fail(new InvalidInput({ message: `"${text}" is not an assertion. ${why}`, hint }))

const operand = (
  text: string,
  word: string,
  where: string,
  wants: "point" | "range"
): Result.Result<Address.Address, AddressParseError | InvalidInput> => {
  const parsed = Address.parse(where)
  if (Result.isFailure(parsed)) {
    return Result.fail(
      new AddressParseError({
        message: `In "${text}": ${parsed.failure.message}`,
        hint: parsed.failure.hint
      })
    )
  }
  const isRange = parsed.success.spec._tag === "Range"
  if (isRange === (wants === "range")) return Result.succeed(parsed.success)
  return wants === "range"
    ? invalid(text, `"${word}" takes a range.`, `Write a range, e.g. ${word} 1s..2s or ${word} #40..#50.`)
    : invalid(text, `"${word}" takes one frame.`, `Write a point, e.g. ${word} 1s or use "during ${where}".`)
}

const parseWhen = (
  text: string,
  word: string,
  where: string
): Result.Result<When, AddressParseError | InvalidInput> => {
  switch (word) {
    case "at":
      return Result.map(operand(text, word, where, "point"), (point) => ({ _tag: "At" as const, point }))
    case "by":
      return Result.map(operand(text, word, where, "point"), (point) => ({ _tag: "By" as const, point }))
    case "after":
      return Result.map(operand(text, word, where, "point"), (point) => ({ _tag: "After" as const, point }))
    case "before":
      return Result.map(operand(text, word, where, "point"), (point) => ({ _tag: "Before" as const, point }))
    case "during":
    case "within":
      return Result.map(operand(text, word, where, "range"), (range) => ({ _tag: "During" as const, range }))
    default:
      return invalid(
        text,
        `"${word}" is not a time word; use ${WHENS.join(", ")}.`,
        `Write e.g. box.x <= 600 at 1s.`
      )
  }
}

const isRelation = (w: string): w is Relation => (RELATIONS as ReadonlyArray<string>).includes(w)

/** Parse assertion text into a typed AST. Pure; addresses are parsed but not resolved. */
export const parseAssertion = (input: string): Result.Result<Assertion, AddressParseError | InvalidInput> => {
  const text = input.trim().replace(/\s+/g, " ")
  if (text.length === 0) return invalid(input, "It is empty.", `Write one, ${EXAMPLES}.`)
  if (text.startsWith("@")) {
    const m = MARKER.exec(text)
    if (!m) {
      return invalid(
        text,
        "A marker assertion is @name, a relation and an address.",
        "Write e.g. @impact within #40..#50 or @settle before 2s."
      )
    }
    const marker = m[1]!
    const relation = m[2]!
    const where = m[3]!
    if (!isRelation(relation)) {
      return invalid(
        text,
        `"${relation}" is not a relation; use ${RELATIONS.join(", ")}.`,
        `Write e.g. @${marker} within #40..#50.`
      )
    }
    return Result.map(
      operand(text, relation, where, relation === "within" ? "range" : "point"),
      (address) => ({
        _tag: "Marker" as const,
        text,
        marker,
        relation,
        where: address
      })
    )
  }
  const m = COMPARE.exec(text)
  if (!m) {
    return invalid(
      text,
      "Compare a track with a number, optionally followed by when.",
      `Write it like ${EXAMPLES}.`
    )
  }
  const track = m[1]!
  const op = m[2] as Op
  const value = Number(m[3])
  const word = m[4]
  const where = m[5]
  const when: Result.Result<When, AddressParseError | InvalidInput> =
    word === undefined || where === undefined
      ? Result.succeed({ _tag: "Always" })
      : parseWhen(text, word, where)
  return Result.map(when, (w) => ({ _tag: "Compare" as const, text, track, op, value, when: w }))
}
