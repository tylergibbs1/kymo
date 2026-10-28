/**
 * Slots for providers without an adapter yet. Naming one fails before any task runs, with what to do
 * about it, instead of failing per task mid-run.
 */
import { Effect } from "effect"
import { type ModelBackend, ModelNotConfigured } from "../Model.ts"

export type Provider = "openai" | "gemini"

const HOW: { readonly [P in Provider]: string } = {
  openai:
    "Add eval/src/models/OpenAI.ts implementing ModelBackend (Responses API with function tools; MCP images become input_image parts) and register it in Models.ts.",
  gemini:
    "Add eval/src/models/Gemini.ts implementing ModelBackend (generateContent with functionDeclarations; MCP images become inlineData parts) and register it in Models.ts."
}

export const unconfigured = (
  provider: Provider,
  model: string
): Effect.Effect<ModelBackend, ModelNotConfigured> =>
  Effect.fail(
    new ModelNotConfigured({ model, message: `No ${provider} adapter is configured. ${HOW[provider]}` })
  )
