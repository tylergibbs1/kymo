/**
 * Claude through the Messages API. MCP tool results become `tool_result` blocks whose content keeps
 * the server's order: each text label, then its image, so the model reads the label before the frame.
 */
import Anthropic from "@anthropic-ai/sdk"
import { Effect } from "effect"
import { type Conversation, type Input, type ModelBackend, ModelError, type Turn } from "../Model.ts"
import type { Block, JsonObject, ToolOutcome } from "../Tools.ts"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

export interface AnthropicOptions {
  readonly model: string
  /** Pinned explicitly: model defaults differ (Opus 5.5 defaults to medium), and runs must compare. */
  readonly effort: Effort
  readonly maxTokens: number
  /** Injected in tests; defaults to a client reading ANTHROPIC_API_KEY. */
  readonly client?: Pick<Anthropic, "messages">
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
type ImageType = (typeof IMAGE_TYPES)[number]
const isImageType = (m: string): m is ImageType => (IMAGE_TYPES as ReadonlyArray<string>).includes(m)

const toContent = (
  blocks: ReadonlyArray<Block>
): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> =>
  blocks.map((b) =>
    b._tag === "text"
      ? { type: "text", text: b.text }
      : isImageType(b.mimeType)
        ? { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } }
        : { type: "text", text: `[${b.mimeType} image omitted: the API takes png, jpeg, gif or webp]` }
  )

export const toolResult = (id: string, outcome: ToolOutcome): Anthropic.ToolResultBlockParam => {
  const content = toContent(outcome.blocks)
  return {
    type: "tool_result",
    tool_use_id: id,
    content: content.length > 0 ? content : [{ type: "text", text: "(empty result)" }],
    ...(outcome.isError ? { is_error: true } : {})
  }
}

const toInputSchema = (schema: JsonObject): Anthropic.Tool.InputSchema => ({ ...schema, type: "object" })

const describe = (cause: unknown): string =>
  cause instanceof Anthropic.APIError
    ? `${cause.status ?? "no status"} ${cause.name}: ${cause.message}`
    : cause instanceof Error
      ? cause.message
      : String(cause)

export const anthropic = (options: AnthropicOptions): ModelBackend => ({
  id: options.model,
  start: (session) =>
    Effect.try({
      try: () => options.client ?? new Anthropic(),
      catch: (cause) => new ModelError({ model: options.model, message: describe(cause) })
    }).pipe(
      Effect.map((client): Conversation => {
        const tools: Array<Anthropic.Tool> = session.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: toInputSchema(t.inputSchema)
        }))
        // Append-only history: thinking blocks are passed back exactly as received.
        const messages: Array<Anthropic.MessageParam> = []
        const send = (input: Input): Effect.Effect<Turn, ModelError> => {
          messages.push(
            input._tag === "user"
              ? { role: "user", content: input.text }
              : { role: "user", content: input.results.map((r) => toolResult(r.call.id, r.outcome)) }
          )
          return Effect.tryPromise({
            try: (signal) =>
              client.messages.create(
                {
                  model: options.model,
                  max_tokens: options.maxTokens,
                  system: session.system,
                  tools,
                  messages,
                  output_config: { effort: options.effort },
                  cache_control: { type: "ephemeral" }
                },
                { signal }
              ),
            catch: (cause) => new ModelError({ model: options.model, message: describe(cause) })
          }).pipe(
            Effect.map((response): Turn => {
              messages.push({ role: "assistant", content: response.content })
              const u = response.usage
              return {
                text: response.content
                  .flatMap((b) => (b.type === "text" ? [b.text] : []))
                  .join("\n")
                  .trim(),
                calls: response.content.flatMap((b) =>
                  b.type === "tool_use"
                    ? [{ id: b.id, name: b.name, args: (b.input ?? {}) as JsonObject }]
                    : []
                ),
                usage: {
                  inputTokens:
                    u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
                  outputTokens: u.output_tokens
                },
                refused: response.stop_reason === "refusal"
              }
            })
          )
        }
        return { send }
      })
    )
})
