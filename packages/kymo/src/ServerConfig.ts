/**
 * The MCP server's switches, defined once. The server reads them only through `fromEnv`; anything that
 * starts a server (the eval) writes them only through `toEnv`, so a switch nobody reads cannot exist.
 */
import { Address, InvalidInput } from "@kymo/core"
import { Effect, Schema } from "effect"

/** `on`: worked examples in tool descriptions and `_meta`. */
export const ToolExamples = Schema.Literals(["on", "off"])
export type ToolExamples = typeof ToolExamples.Type

/** The text block next to `structuredContent`: the JSON itself, or a compact Markdown rendering of it. */
export const TextFormat = Schema.Literals(["json", "markdown"])
export type TextFormat = typeof TextFormat.Type

export const ServerConfig = Schema.Struct({
  toolExamples: ToolExamples,
  labelStyle: Address.LabelStyle,
  textFormat: TextFormat
})
export type ServerConfig = typeof ServerConfig.Type

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  toolExamples: "on",
  labelStyle: Address.DEFAULT_LABEL_STYLE,
  textFormat: "json"
}

/** The environment variable behind each switch. */
export const ENV_NAMES = {
  toolExamples: "KYMO_TOOL_EXAMPLES",
  labelStyle: "KYMO_LABEL_STYLE",
  textFormat: "KYMO_TEXT_FORMAT"
} as const satisfies { readonly [K in keyof ServerConfig]: string }

type Key = keyof ServerConfig
const KEYS = Object.keys(ENV_NAMES) as ReadonlyArray<Key>

/** The environment that makes a server run with `config`. Every switch is written, defaults included. */
export const toEnv = (config: ServerConfig): Readonly<Record<string, string>> =>
  Object.fromEntries(KEYS.map((key) => [ENV_NAMES[key], config[key]]))

/** Read the switches from an environment. Unset or empty means the default; anything else must be valid. */
export const fromEnv = (
  env: Readonly<Record<string, string | undefined>>
): Effect.Effect<ServerConfig, InvalidInput> => {
  const raw = Object.fromEntries(
    KEYS.map((key) => {
      const value = env[ENV_NAMES[key]]
      return [key, value === undefined || value === "" ? DEFAULT_SERVER_CONFIG[key] : value]
    })
  )
  const bad = KEYS.filter((key) => !Schema.is(ServerConfig.fields[key])(raw[key]))
  return bad.length === 0
    ? Effect.succeed(raw as ServerConfig)
    : Effect.fail(
        new InvalidInput({
          message: bad
            .map(
              (key) =>
                `${ENV_NAMES[key]}=${JSON.stringify(raw[key])} is not valid; use ${ServerConfig.fields[key].literals.join(", ")}.`
            )
            .join(" "),
          hint: `Unset ${bad.map((key) => ENV_NAMES[key]).join(", ")} for the default, or set one of the values listed.`
        })
      )
}
