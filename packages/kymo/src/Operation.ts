import { BackendFailure, InvalidInput, type KymoError } from "@kymo/core"
import type { Workspace } from "@kymo/sources"
import { Effect, Result, Schema } from "effect"
import type { FrameLabels } from "./FrameLabels.ts"
import type { OutputDir } from "./OutputDir.ts"
import type { Sheet } from "./Sheets.ts"

/** What every operation needs from its environment. `KymoLive` provides all of it. */
export type KymoServices = Workspace | OutputDir | FrameLabels

type Codec<T> = Schema.Codec<T, unknown, never, never>

/**
 * How a JSON Lines command prints its result: one `line` per item of `field`, then one `summary` line
 * with every other field. Both schemas are cut from the output Schema, so the printed shape and the
 * published one cannot drift apart.
 */
export interface JsonLines {
  readonly field: string
  readonly line: Codec<unknown>
  readonly summary: Codec<unknown>
}

type ArrayFields<F extends Schema.Struct.Fields> = {
  [K in keyof F & string]: F[K] extends Schema.$Array<infer _> ? K : never
}[keyof F & string]

/** The JSON Lines shape of an output Struct, streaming the array field `field`. */
export const jsonLines = <F extends Schema.Struct.Fields>(
  output: Schema.Struct<F>,
  field: ArrayFields<F>
): JsonLines => {
  const items = output.fields[field] as unknown as Schema.$Array<Codec<unknown>>
  const rest = Object.fromEntries(Object.entries(output.fields).filter(([k]) => k !== field))
  return {
    field,
    line: items.value,
    summary: Schema.Struct(rest).annotate({
      description: `The last line: every field but ${field}, whose items came one per line before it.`
    }) as unknown as Codec<unknown>
  }
}

/** Split an encoded result into the lines a JSON Lines command prints. */
export const toLines = (lines: JsonLines, encoded: Readonly<Record<string, unknown>>): Array<unknown> => {
  const { [lines.field]: items, ...summary } = encoded
  return [...(Array.isArray(items) ? items : []), summary]
}

/**
 * One kymo operation. The input and output Schemas are the single source of truth: CLI flags and
 * `--json`, `kymo schema`, and MCP `inputSchema`/`outputSchema` are all derived from them.
 */
export interface Operation<
  I extends Codec<unknown> = Codec<unknown>,
  O extends Codec<unknown> = Codec<unknown>
> {
  /** `frames`; the MCP tool is `kymo_frames`. */
  readonly name: string
  /** A short human title, e.g. "Look at frames". */
  readonly title: string
  /** What it is for and when to use it instead of its neighbour; shown in CLI help and MCP. */
  readonly description: string
  /** What one call can cost in images, e.g. "≤4 images, ≤4784 visual tokens each at high-res". */
  readonly cost: string
  /** Typed against the Schema, so an example that stops decoding is a compile error. */
  readonly examples: ReadonlyArray<I["Encoded"]>
  readonly input: I
  readonly output: O
  /** False only for operations that change the world (record). */
  readonly readOnly: boolean
  /** Set for JSON Lines commands: the CLI prints the result as these lines. Build it with `jsonLines`. */
  readonly lines?: JsonLines
  /** The images a result carries, in order, for shells that attach them (MCP). */
  images?(output: O["Type"]): ReadonlyArray<Sheet>
  /**
   * For operations that give a verdict (check): false when the result is a failure. The CLI still
   * prints the result and then exits with `VERDICT_FAILED_EXIT` instead of 0.
   */
  passed?(output: O["Type"]): boolean
  run(input: I["Type"]): Effect.Effect<O["Type"], KymoError, KymoServices>
}

export type AnyOperation = Operation<Codec<unknown>, Codec<unknown>>

export const define = <I extends Codec<unknown>, O extends Codec<unknown>>(
  op: Operation<I, O>
): Operation<I, O> => op

/** The CLI flag of an input field: `maxEdge` is `--max-edge`. */
export const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/**
 * An option as both shells spell it, for hints: `box=120,80,64,64 (CLI: --box 120,80,64,64)`, or for
 * a list `tracks=["box.x","box.y"] (CLI: --tracks box.x box.y)`, or a switch `uncapped=true (CLI: --uncapped)`. The key is typed against the input's
 * fields, so a hint cannot name an option the input does not have.
 */
export const optionHint = <F extends Schema.Struct.Fields>(
  _fields: F,
  key: keyof F & string,
  value: string | ReadonlyArray<string> | true
): string =>
  value === true
    ? `${key}=true (CLI: --${kebab(key)})`
    : typeof value === "string"
      ? `${key}=${value} (CLI: --${kebab(key)} ${value})`
      : `${key}=${JSON.stringify(value)} (CLI: --${kebab(key)} ${value.join(" ")})`

/** Unknown keys are errors: a typo silently falling back to a default is the worst failure. */
const parseOptions = { onExcessProperty: "error", errors: "all" } as const

/** `Expected string\n  at ["source"]` → `source: expected string`; an unknown key → `x: is not a field`. */
const formatIssues = (message: string): string => {
  const lines = message.split("\n")
  const issues: Array<string> = []
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!.trim()
    if (line.length === 0 || line.startsWith("at [")) continue
    const at = /^at \[(.*)\]$/.exec(lines[k + 1]?.trim() ?? "")
    const path = at ? at[1]!.replace(/"/g, "").replace(/,/g, ".") : ""
    const what =
      line === "Expected no excess property"
        ? "is not a field"
        : `${line.charAt(0).toLowerCase()}${line.slice(1)}`
    const text = `${path ? `${path}: ` : ""}${what}`
    if (!issues.includes(text)) issues.push(text)
  }
  return issues.join("; ")
}

/** The shapes an input can take: the members of a union (`at` or `range`), or the one schema. */
const shapesOf = (input: Codec<unknown>): ReadonlyArray<Codec<unknown>> =>
  "members" in input && Array.isArray(input.members)
    ? (input.members as ReadonlyArray<Codec<unknown>>)
    : [input]

/**
 * The issues of the shape the input comes closest to. Reporting every shape's issues would blame
 * fields the caller never meant (`at: is not a field` for a bad `view`), so only the best one is told.
 */
const closestIssues = (input: Codec<unknown>, raw: unknown): string => {
  const candidates = shapesOf(input).flatMap((shape) => {
    const result = Schema.decodeUnknownResult(shape)(raw, parseOptions)
    return Result.isFailure(result) ? [formatIssues(result.failure.message)] : []
  })
  return candidates.reduce((best, issues) =>
    issues.split("; ").length < best.split("; ").length ? issues : best
  )
}

/** Decode raw input (CLI `--json`, flags, MCP arguments, library calls) with the operation's Schema. */
export const decodeInput = <I extends Codec<unknown>, O extends Codec<unknown>>(
  op: Operation<I, O>,
  raw: unknown
): Effect.Effect<I["Type"], InvalidInput> =>
  Schema.decodeUnknownEffect(op.input)(raw, parseOptions).pipe(
    Effect.mapError(
      () =>
        new InvalidInput({
          message: `Invalid ${op.name} input: ${closestIssues(op.input, raw)}.`,
          hint: `Run \`kymo schema ${op.name}\` for every field. Example: ${JSON.stringify(op.examples[0] ?? {})}`
        })
    )
  )

/** The JSON form of an output, exactly as the output Schema describes it. */
export const encodeOutput = <I extends Codec<unknown>, O extends Codec<unknown>>(
  op: Operation<I, O>,
  value: O["Type"]
): Effect.Effect<unknown, BackendFailure> =>
  Schema.encodeUnknownEffect(op.output)(value).pipe(
    Effect.mapError(
      (error) =>
        new BackendFailure({
          message: `kymo produced a ${op.name} result that does not match its own schema: ${formatIssues(error.message)}.`,
          hint: "This is a kymo bug; report it with the command that failed."
        })
    )
  )

/** Decode, run, encode: raw JSON in, JSON out. What every shell calls. */
export const execute = <I extends Codec<unknown>, O extends Codec<unknown>>(
  op: Operation<I, O>,
  raw: unknown
): Effect.Effect<unknown, KymoError, KymoServices> =>
  decodeInput(op, raw).pipe(
    Effect.flatMap((input) => op.run(input)),
    Effect.flatMap((output) => encodeOutput(op, output))
  )

/** JSON Schema (draft 2020-12) of a Schema's encoded side, with every definition inlined under `$defs`. */
export const jsonSchema = (schema: Schema.Top): Record<string, unknown> => {
  const doc = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  const defs = doc.definitions
  const root = doc.schema as Record<string, unknown>
  const ref = typeof root["$ref"] === "string" ? root["$ref"].replace("#/$defs/", "") : undefined
  if (ref !== undefined && defs[ref] !== undefined) {
    const rest = Object.fromEntries(Object.entries(defs).filter(([k]) => k !== ref))
    const inlined = defs[ref] as Record<string, unknown>
    return Object.keys(rest).length === 0 ? inlined : { ...inlined, $defs: rest }
  }
  return Object.keys(defs).length === 0 ? root : { ...root, $defs: defs }
}

export interface ObjectSchema {
  readonly type: "object"
  readonly properties: Readonly<Record<string, Record<string, unknown>>>
  readonly required: ReadonlyArray<string>
  readonly [key: string]: unknown
}

/**
 * An input's JSON Schema as one object, for consumers that need an object root (MCP tool inputs,
 * CLI flags). A union of shapes (`at` or `range`) is merged: every property of every shape, required
 * only when every shape requires it. The Schema itself still rejects mixing shapes.
 */
export const flatInputSchema = (op: AnyOperation): ObjectSchema => {
  const { anyOf, ...root } = jsonSchema(op.input)
  const shapes = (Array.isArray(anyOf) ? anyOf : [root]) as ReadonlyArray<{
    readonly properties?: Record<string, Record<string, unknown>>
    readonly required?: ReadonlyArray<string>
  }>
  const properties: Record<string, Record<string, unknown>> = {}
  for (const shape of shapes) for (const [k, v] of Object.entries(shape.properties ?? {})) properties[k] ??= v
  const required = Object.keys(properties).filter((k) => shapes.every((s) => s.required?.includes(k)))
  return { ...root, type: "object", properties, required, additionalProperties: false }
}

/**
 * `{input, output}` JSON Schemas for one operation, as `kymo schema <op>` prints them, plus `lines`
 * (`{field, line, summary}`) for JSON Lines commands: the shapes the CLI actually prints.
 */
export const schemasOf = (op: AnyOperation) => ({
  name: op.name,
  description: op.description,
  input: jsonSchema(op.input),
  output: jsonSchema(op.output),
  ...(op.lines === undefined
    ? {}
    : {
        lines: {
          field: op.lines.field,
          line: jsonSchema(op.lines.line),
          summary: jsonSchema(op.lines.summary)
        }
      })
})
