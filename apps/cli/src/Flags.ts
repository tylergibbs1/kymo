/**
 * CLI flags derived from an operation's input JSON Schema, so a field added to a Schema is a flag
 * with no CLI change. Field `maxEdge` is flag `--max-edge`; the source fields are positional.
 */
import { type ObjectSchema, kebab } from "kymo"
import { Option } from "effect"
import { Argument, Flag } from "effect/cli"

type Scalar = "text" | "integer" | "number"

export type FieldKind =
  | { readonly _tag: "positional" }
  | { readonly _tag: "scalar"; readonly type: Scalar }
  | { readonly _tag: "switch" }
  | { readonly _tag: "list" }
  /** A choice of names or an object, like target: `--target standard`, or `--max-edge 1200 --max-tokens 2000`. */
  | {
      readonly _tag: "choiceOrObject"
      readonly parts: ReadonlyArray<{ readonly key: string; readonly flag: string; readonly type: Scalar }>
    }

export interface Field {
  readonly key: string
  readonly flag: string
  readonly description: string
  readonly kind: FieldKind
}

/** Fields that name what to look at, taken in order as positional arguments: `kymo compare a.mp4 b.mp4`. */
const POSITIONAL = ["source", "src", "a", "b"]

/** The value of `--target` that selects the object form. */
export const OBJECT_CHOICE = "custom"

type Json = Readonly<Record<string, unknown>>

const scalarOf = (schema: Json): Scalar | undefined =>
  schema["type"] === "integer"
    ? "integer"
    : schema["type"] === "number"
      ? "number"
      : schema["type"] === "string"
        ? "text"
        : undefined

const kindOf = (key: string, schema: Json): FieldKind => {
  if (POSITIONAL.includes(key)) return { _tag: "positional" }
  if (schema["type"] === "boolean") return { _tag: "switch" }
  if (schema["type"] === "array") return { _tag: "list" }
  const alternatives = Array.isArray(schema["anyOf"]) ? (schema["anyOf"] as ReadonlyArray<Json>) : []
  const object = alternatives.find((a) => a["type"] === "object")
  if (object !== undefined) {
    const props = (object["properties"] ?? {}) as Readonly<Record<string, Json>>
    return {
      _tag: "choiceOrObject",
      parts: Object.entries(props).map(([k, v]) => ({ key: k, flag: kebab(k), type: scalarOf(v) ?? "text" }))
    }
  }
  return { _tag: "scalar", type: scalarOf(schema) ?? "text" }
}

const choices = (schema: Json): string => {
  const values = [
    ...(Array.isArray(schema["enum"]) ? schema["enum"] : []),
    ...(Array.isArray(schema["anyOf"])
      ? (schema["anyOf"] as ReadonlyArray<Json>).flatMap((a) => (Array.isArray(a["enum"]) ? a["enum"] : []))
      : [])
  ]
  return values.length > 0 ? ` One of: ${values.join(", ")}.` : ""
}

export const fieldsOf = (schema: ObjectSchema): ReadonlyArray<Field> =>
  Object.entries(schema.properties).map(([key, prop]) => ({
    key,
    flag: kebab(key),
    description: `${typeof prop["description"] === "string" ? prop["description"] : key}${choices(prop)}`,
    kind: kindOf(key, prop)
  }))

/** Flags every operation command takes besides its fields. */
export const COMMON_FLAGS = {
  json: 'The whole input as a JSON object, e.g. \'{"source":"clip1","at":["0f"]}\'. Flags given alongside override its fields.',
  out: "Directory for images. Default: a fresh kymo-* temp directory per run."
} as const

const scalarFlag = (flag: string, type: Scalar, description: string): Flag.Flag<Option.Option<unknown>> => {
  switch (type) {
    case "integer":
      return Flag.Int(flag).pipe(Flag.withDescription(description), Flag.optional)
    case "number":
      return Flag.Finite(flag).pipe(Flag.withDescription(description), Flag.optional)
    case "text":
      return Flag.String(flag).pipe(Flag.withDescription(description), Flag.optional)
  }
}

/** The effect/cli parameters for these fields, keyed by field (and part) name. */
export const paramsOf = (fields: ReadonlyArray<Field>) => {
  const params: Record<string, Flag.Flag<unknown> | Argument.Argument<unknown>> = {}
  for (const f of fields) {
    switch (f.kind._tag) {
      case "positional":
        params[f.key] = Argument.String(f.key).pipe(
          Argument.withDescription(f.description),
          Argument.optional
        )
        break
      case "switch":
        params[f.key] = Flag.Boolean(f.flag).pipe(Flag.withDescription(f.description), Flag.optional)
        break
      case "list":
        params[f.key] = Flag.String(f.flag).pipe(
          Flag.withDescription(`${f.description} Give several values after one flag: --${f.flag} a b c.`),
          Flag.atLeast(0)
        )
        break
      case "scalar":
        params[f.key] = scalarFlag(f.flag, f.kind.type, f.description)
        break
      case "choiceOrObject":
        params[f.key] = scalarFlag(
          f.flag,
          "text",
          `${f.description} Or ${OBJECT_CHOICE} with the flags below.`
        )
        for (const part of f.kind.parts)
          params[part.key] = scalarFlag(
            part.flag,
            part.type,
            `With --${f.flag} ${OBJECT_CHOICE}: ${part.key}.`
          )
        break
    }
  }
  params["json"] = Flag.String("json").pipe(Flag.withDescription(COMMON_FLAGS.json), Flag.optional)
  params["out"] = Flag.String("out").pipe(Flag.withDescription(COMMON_FLAGS.out), Flag.optional)
  return params
}

const given = (value: unknown): value is Option.Some<unknown> =>
  Option.isOption(value) && Option.isSome(value)

/** The input object the parsed flags describe: only what was given, so Schema defaults apply to the rest. */
export const inputOf = (fields: ReadonlyArray<Field>, values: Readonly<Record<string, unknown>>) => {
  const input: Record<string, unknown> = {}
  for (const f of fields) {
    const value = values[f.key]
    if (f.kind._tag === "list") {
      if (Array.isArray(value) && value.length > 0) input[f.key] = value
    } else if (f.kind._tag === "choiceOrObject") {
      const anyPart = f.kind.parts.some((p) => given(values[p.key]))
      const choice = given(value) ? value.value : undefined
      if (choice === OBJECT_CHOICE || (choice === undefined && anyPart)) {
        input[f.key] = Object.fromEntries(
          f.kind.parts.flatMap((p) => {
            const v = values[p.key]
            return given(v) ? [[p.key, v.value]] : []
          })
        )
      } else if (choice !== undefined) input[f.key] = choice
    } else if (given(value)) input[f.key] = value.value
  }
  return input
}

/** Flags that take a value, by name, and whether they take several. */
export const valueFlags = (fields: ReadonlyArray<Field>): ReadonlyMap<string, "one" | "many"> => {
  const out = new Map<string, "one" | "many">([
    ["json", "one"],
    ["out", "one"]
  ])
  for (const f of fields) {
    if (f.kind._tag === "list") out.set(f.flag, "many")
    else if (f.kind._tag === "scalar") out.set(f.flag, "one")
    else if (f.kind._tag === "choiceOrObject") {
      out.set(f.flag, "one")
      for (const p of f.kind.parts) out.set(p.flag, "one")
    }
  }
  return out
}

/**
 * Rewrite `--at 0f 1s -1f` as `--at=0f --at=1s --at=-1f` and `--range -2s..-1f` as `--range=-2s..-1f`,
 * so values that start with `-` (addresses counted from the end) are never read as flags.
 */
export const normalize = (
  argv: ReadonlyArray<string>,
  flagsFor: (command: string) => ReadonlyMap<string, "one" | "many"> | undefined
): Array<string> => {
  const command = argv.find((a) => !a.startsWith("-"))
  const flags = command === undefined ? undefined : flagsFor(command)
  if (flags === undefined) return [...argv]
  const out: Array<string> = []
  for (let k = 0; k < argv.length; k++) {
    const token = argv[k]!
    const arity = token.startsWith("--") && !token.includes("=") ? flags.get(token.slice(2)) : undefined
    if (arity === undefined) {
      out.push(token)
      continue
    }
    let taken = 0
    while (k + 1 < argv.length && !argv[k + 1]!.startsWith("--") && (arity === "many" || taken === 0)) {
      out.push(`${token}=${argv[++k]!}`)
      taken++
    }
    if (taken === 0) out.push(token)
  }
  return out
}
