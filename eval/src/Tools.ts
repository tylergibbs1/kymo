/**
 * The tool side of the loop: what the model can call. `ToolBackend` is the whole interface; the MCP
 * implementation spawns (or is handed) a server and translates MCP results into `ToolOutcome`s.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Schema, type Scope } from "effect"

export type JsonObject = { readonly [key: string]: unknown }

export interface ToolSpec {
  readonly name: string
  readonly description: string
  /** JSON Schema of the arguments, as the server publishes it. */
  readonly inputSchema: JsonObject
}

export type Block =
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "image"; readonly data: string; readonly mimeType: string }

/** One tool result. `isError` results are the model's to read and fix, not harness failures. */
export interface ToolOutcome {
  readonly isError: boolean
  readonly blocks: ReadonlyArray<Block>
  readonly structured: unknown
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly args: JsonObject
}

/** The server went away or broke protocol: the task cannot continue. */
export class ToolTransportError extends Schema.TaggedError<ToolTransportError>()("ToolTransportError", {
  message: Schema.String
}) {}

export interface ToolBackend {
  readonly tools: ReadonlyArray<ToolSpec>
  readonly call: (name: string, args: JsonObject) => Effect.Effect<ToolOutcome, ToolTransportError>
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Errors the model caused (unknown tool, bad arguments) go back to it as an error result. */
const isCallerError = (cause: unknown) =>
  cause instanceof McpError &&
  (cause.code === ErrorCode.InvalidParams || cause.code === ErrorCode.MethodNotFound)

const ContentBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String })
])
const decodeBlock = Schema.decodeUnknownOption(ContentBlock)

/** MCP content → blocks the model adapters understand. Resource links and audio are described as text. */
export const toBlocks = (content: ReadonlyArray<unknown>): ReadonlyArray<Block> =>
  content.map((raw): Block => {
    const block = decodeBlock(raw)
    if (block._tag === "Some") {
      return block.value.type === "text"
        ? { _tag: "text", text: block.value.text }
        : { _tag: "image", data: block.value.data, mimeType: block.value.mimeType }
    }
    return { _tag: "text", text: JSON.stringify(raw) }
  })

/** A ToolBackend over any connected MCP transport. Closes the client with the Scope. */
export const connect = (transport: Transport): Effect.Effect<ToolBackend, ToolTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const c = new Client({ name: "kymo-eval", version: "0.0.0" })
          await c.connect(transport)
          return c
        },
        catch: (cause) => new ToolTransportError({ message: `Could not connect: ${messageOf(cause)}` })
      }),
      (c) => Effect.promise(() => c.close().catch(() => undefined))
    )
    const listed = yield* Effect.tryPromise({
      try: () => client.listTools(),
      catch: (cause) => new ToolTransportError({ message: `tools/list failed: ${messageOf(cause)}` })
    })
    const tools: ReadonlyArray<ToolSpec> = listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema
    }))
    const call = (name: string, args: JsonObject): Effect.Effect<ToolOutcome, ToolTransportError> =>
      Effect.tryPromise({
        try: () => client.callTool({ name, arguments: { ...args } }),
        catch: (cause) => cause
      }).pipe(
        Effect.map((result): ToolOutcome => ({
          isError: result.isError === true,
          blocks: toBlocks(Array.isArray(result.content) ? result.content : []),
          structured: result.structuredContent
        })),
        Effect.catch((cause) =>
          isCallerError(cause)
            ? Effect.succeed<ToolOutcome>({
                isError: true,
                blocks: [{ _tag: "text", text: messageOf(cause) }],
                structured: undefined
              })
            : Effect.fail(new ToolTransportError({ message: `${name} failed: ${messageOf(cause)}` }))
        )
      )
    return { tools, call }
  })

export interface ServerCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  /** Added to the inherited environment. */
  readonly env: Readonly<Record<string, string>>
  /** Show the server's stderr, or drop it. */
  readonly stderr: "inherit" | "ignore"
}

/** Spawn an MCP server over stdio and connect to it. The process ends with the Scope. */
export const spawn = (server: ServerCommand): Effect.Effect<ToolBackend, ToolTransportError, Scope.Scope> =>
  connect(
    new StdioClientTransport({
      command: server.command,
      args: [...server.args],
      cwd: server.cwd,
      env: { ...getDefaultEnvironment(), ...server.env },
      stderr: server.stderr
    })
  )
