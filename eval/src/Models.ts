/** Model names on the command line → backends. */
import { Effect } from "effect"
import { type ModelBackend, ModelNotConfigured } from "./Model.ts"
import { anthropic, type Effort } from "./models/Anthropic.ts"
import { oracle } from "./models/Oracle.ts"
import { unconfigured } from "./models/Unconfigured.ts"

export const DEFAULT_MODELS = ["oracle", "claude-opus-5-5", "claude-sonnet-5-5"] as const

export interface ModelOptions {
  readonly effort: Effort
  readonly maxTokens: number
}

export const modelFor = (
  name: string,
  options: ModelOptions
): Effect.Effect<ModelBackend, ModelNotConfigured> => {
  if (name === "oracle") return Effect.succeed(oracle)
  if (name.startsWith("claude-")) {
    return process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]
      ? Effect.succeed(anthropic({ model: name, effort: options.effort, maxTokens: options.maxTokens }))
      : Effect.fail(
          new ModelNotConfigured({ model: name, message: "Set ANTHROPIC_API_KEY to run Claude models." })
        )
  }
  if (/^(gpt-|o\d)/.test(name)) return unconfigured("openai", name)
  if (name.startsWith("gemini-")) return unconfigured("gemini", name)
  return Effect.fail(
    new ModelNotConfigured({
      model: name,
      message: `Unknown model "${name}". Use oracle, a claude-* id (e.g. ${DEFAULT_MODELS.slice(1).join(", ")}), gpt-* or gemini-*.`
    })
  )
}
