/**
 * The only module that touches Effect's MCP API (`effect/ai`), which is still marked unstable. The rest
 * of the server speaks in the plain types below, so an API change is fixed here and nowhere else.
 */
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer, Logger, Schema, type Stdio } from "effect"
import { McpProtocol, McpSchema, McpServer } from "effect/ai"
import { HttpRouter } from "effect/http"
import { createServer } from "node:http"

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: Uint8Array; readonly mimeType: string }
  | { readonly type: "resource_link"; readonly uri: string; readonly name: string; readonly mimeType: string }

export interface ToolResult {
  readonly content: ReadonlyArray<Content>
  /** Present on success; matches the tool's output schema. */
  readonly structured?: unknown
  readonly isError: boolean
}

export interface ToolSpec<R> {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: { readonly type: "object"; readonly [key: string]: unknown }
  readonly outputSchema: Readonly<Record<string, unknown>>
  readonly readOnly: boolean
  readonly openWorld: boolean
  readonly meta?: Readonly<Record<string, unknown>>
  /** Never fails: user mistakes come back as `isError` results, not protocol errors. */
  readonly handle: (args: unknown) => Effect.Effect<ToolResult, never, R>
}

export interface Blob {
  readonly mimeType: string
  readonly bytes: Uint8Array
}

export interface ResourceTemplateSpec<R> {
  readonly name: string
  readonly description: string
  readonly mimeType: string
  /** `kymo://` + `{a}` + `/sheet/` + `{b}` + `.png`: literal pieces around exactly two parameters. */
  readonly prefix: string
  readonly middle: string
  readonly suffix: string
  readonly params: readonly [string, string]
  /** Fails with a message when the resource does not exist. */
  readonly read: (a: string, b: string) => Effect.Effect<Blob, string, R>
}

export interface ServerSpec<R> {
  readonly name: string
  readonly version: string
  readonly instructions: string
  readonly tools: ReadonlyArray<ToolSpec<R>>
  readonly templates: ReadonlyArray<ResourceTemplateSpec<R>>
}

const toContent = (c: Content) =>
  c.type === "text"
    ? { type: "text" as const, text: c.text }
    : c.type === "image"
      ? { type: "image" as const, data: c.data, mimeType: c.mimeType }
      : { type: "resource_link" as const, uri: c.uri, name: c.name, mimeType: c.mimeType }

const register = <R>(spec: ServerSpec<R>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer
    const services = yield* Effect.context<R>()
    for (const tool of spec.tools) {
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: {
            title: tool.title,
            readOnlyHint: tool.readOnly,
            destructiveHint: false,
            idempotentHint: tool.readOnly,
            openWorldHint: tool.openWorld
          },
          ...(tool.meta === undefined ? {} : { _meta: tool.meta })
        }),
        annotations: Context.empty(),
        handle: (args: unknown) =>
          tool.handle(args).pipe(
            Effect.map(
              (result) =>
                new McpSchema.CallToolResult({
                  content: result.content.map(toContent),
                  isError: result.isError,
                  ...(result.structured === undefined ? {} : { structuredContent: result.structured })
                })
            ),
            Effect.provideContext(services)
          )
      })
    }
    for (const t of spec.templates) {
      const [a, b] = t.params
      const segments = Object.assign([t.prefix, t.middle, t.suffix], { raw: [t.prefix, t.middle, t.suffix] })
      yield* McpServer.registerResource(
        segments,
        McpSchema.param(a, Schema.String),
        McpSchema.param(b, Schema.String)
      )({
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
        content: (uri, first, second) =>
          t.read(decodeURIComponent(first), decodeURIComponent(second)).pipe(
            Effect.map((blob) => ({ contents: [{ uri, mimeType: blob.mimeType, blob: blob.bytes }] })),
            Effect.provideContext(services)
          )
      })
    }
  })

const protocols = [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25] as const

/** Logs go to stderr: on stdio, stdout carries the protocol. */
const logsToStderr = Layer.succeed(Logger.LogToStderr)(true)

const info = <R>(spec: ServerSpec<R>) => ({
  name: spec.name,
  version: spec.version,
  instructions: spec.instructions,
  protocols
})

/** Serve over stdin/stdout until the client disconnects. */
export const layerStdio = <R>(spec: ServerSpec<R>): Layer.Layer<never, never, R | Stdio.Stdio> =>
  Layer.effectDiscard(register(spec)).pipe(
    Layer.provide(McpServer.layerStdio(info(spec))),
    Layer.provide(logsToStderr),
    Layer.orDie
  )

/** Serve Streamable HTTP at `http://localhost:<port>/mcp`. */
export const layerHttp = <R>(spec: ServerSpec<R>, port: number) =>
  HttpRouter.serve(
    Layer.effectDiscard(register(spec)).pipe(
      Layer.provide(McpServer.layerHttp({ ...info(spec), path: "/mcp" }))
    )
  ).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port })),
    Layer.provide(logsToStderr),
    Layer.orDie
  )
