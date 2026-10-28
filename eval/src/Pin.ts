/**
 * Pinned tool arguments: how an experiment variant fixes a tool parameter (say `target=standard`)
 * whatever the model asks for. A pinned parameter is removed from the schema the model sees and
 * overwritten on every call. Pins are checked against the server's published schema, so a variant
 * that names a parameter the server does not have fails before any task runs.
 */
import { Effect, Schema } from "effect"
import type { JsonObject, ToolBackend, ToolSpec } from "./Tools.ts"

export type Pins = Readonly<Record<string, JsonObject>>

export class PinMismatch extends Schema.TaggedError<PinMismatch>()("PinMismatch", {
  message: Schema.String
}) {}

const propertiesOf = (spec: ToolSpec): JsonObject => {
  const props = spec.inputSchema["properties"]
  return typeof props === "object" && props !== null ? (props as JsonObject) : {}
}

/** The tool's schema without the pinned keys. */
const withoutKeys = (spec: ToolSpec, keys: ReadonlyArray<string>): ToolSpec => {
  const properties = Object.fromEntries(Object.entries(propertiesOf(spec)).filter(([k]) => !keys.includes(k)))
  const required = spec.inputSchema["required"]
  return {
    ...spec,
    inputSchema: {
      ...spec.inputSchema,
      properties,
      ...(Array.isArray(required) ? { required: required.filter((k) => !keys.includes(String(k))) } : {})
    }
  }
}

export const pin = (backend: ToolBackend, pins: Pins): Effect.Effect<ToolBackend, PinMismatch> => {
  const problems: Array<string> = []
  for (const [tool, args] of Object.entries(pins)) {
    const spec = backend.tools.find((t) => t.name === tool)
    if (!spec) {
      problems.push(`no tool ${tool}`)
      continue
    }
    const known = Object.keys(propertiesOf(spec))
    for (const key of Object.keys(args)) {
      if (!known.includes(key)) problems.push(`${tool} has no parameter ${key} (it has ${known.join(", ")})`)
    }
  }
  if (problems.length > 0) {
    return Effect.fail(
      new PinMismatch({
        message: `The variant pins arguments the server does not take: ${problems.join("; ")}.`
      })
    )
  }
  return Effect.succeed({
    tools: backend.tools.map((t) => withoutKeys(t, Object.keys(pins[t.name] ?? {}))),
    call: (name, args) => backend.call(name, { ...args, ...pins[name] })
  })
}
