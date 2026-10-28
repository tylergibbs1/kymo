import { Address, BackendFailure, InvalidInput, type KymoError, rate, toPayload } from "@kymo/core"
import {
  type AnyOperation,
  type KymoServices,
  OutputDir,
  type ServerConfig,
  type Sheet,
  decodeInput,
  encodeOutput,
  flatInputSchema,
  frames,
  jsonSchema,
  toolOperations
} from "kymo"
import { Cause, Effect, Result, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { toMarkdown } from "./Markdown.ts"
import type { Content, ResourceTemplateSpec, ServerSpec, ToolResult, ToolSpec } from "./Mcp.ts"

/** How image-producing tools return pictures: inline base64 (default) or resource links only. */
export const ImagesMode = Schema.Literals(["inline", "links"]).annotate({
  description:
    "inline (default): each sheet's PNG is attached after its label. links: only kymo:// resource links, which keeps long sessions small."
})
type ImagesMode = typeof ImagesMode.Type

/** The address help, with labels shown in the style the server draws them. */
const addresses = (style: Address.LabelStyle) =>
  `Addresses: 08s10f (8 s 10 frames), #250 (frame index), 8.33s, -1f (last frame), @impact1+5f (marker plus offset), ranges 2s..4s or 2s..4s:2f (every 2nd frame). Labels show \`${Address.styledLabel(rate(30), 250, style)}\`; pass any address form back.`

const description = (op: AnyOperation, config: ServerConfig): string =>
  [
    op.description,
    op.name === "record" ? undefined : addresses(config.labelStyle),
    `Images: ${op.cost}.`,
    config.toolExamples === "on"
      ? `Examples:\n${op.examples.map((e) => `kymo_${op.name}(${JSON.stringify(e)})`).join("\n")}`
      : undefined
  ]
    .filter((line) => line !== undefined)
    .join("\n\n")

const text = (t: string): Content => ({ type: "text", text: t })

/** The text block next to `structuredContent`: the same data as JSON or Markdown. */
const fallback = (json: unknown, config: ServerConfig): Content =>
  text(config.textFormat === "markdown" ? toMarkdown(json) : JSON.stringify(json))

const errorResult = (e: KymoError): ToolResult => ({
  content: [text(JSON.stringify(toPayload(e)))],
  isError: true
})

/** Every failure, including a bug, becomes an `isError` result the agent can read; interruption stays interruption. */
const recover = (cause: Cause.Cause<KymoError>): Effect.Effect<ToolResult> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
  const error = Cause.findError(cause)
  if (Result.isSuccess(error)) return Effect.succeed(errorResult(error.success))
  const defect = Cause.squash(cause)
  return Effect.succeed(
    errorResult(
      new BackendFailure({
        message: `kymo failed unexpectedly: ${defect instanceof Error ? defect.message : String(defect)}`,
        hint: "This is a kymo bug, not an input problem; report it with the call that failed."
      })
    )
  )
}

/** Split the MCP-only `images` field from the operation's own input. */
const splitImages = (args: unknown): Effect.Effect<{ images: ImagesMode; input: unknown }, InvalidInput> => {
  if (typeof args !== "object" || args === null || !("images" in args))
    return Effect.succeed({ images: "inline", input: args ?? {} })
  const { images, ...input } = args as Record<string, unknown>
  return Schema.is(ImagesMode)(images)
    ? Effect.succeed({ images, input })
    : Effect.fail(
        new InvalidInput({
          message: `images=${JSON.stringify(images)} is not a mode.`,
          hint: 'Use images: "inline" (default) or "links".'
        })
      )
}

/** `kymo://clip1/sheet/0f-08s10f.png`: the handle is the sheet's directory, the span its file name. */
export const sheetUri = (sheet: Sheet): string =>
  `kymo://${basename(dirname(sheet.path))}/sheet/${encodeURIComponent(sheet.span)}.png`

const sheetContent = (sheet: Sheet, images: ImagesMode) =>
  Effect.map(
    images === "inline"
      ? Effect.promise(() => readFile(sheet.path)).pipe(
          Effect.map((bytes) => [
            { type: "image", data: new Uint8Array(bytes), mimeType: "image/png" } as const
          ])
        )
      : Effect.succeed([]),
    (image): ReadonlyArray<Content> => [
      text(sheet.label),
      ...image,
      { type: "resource_link", uri: sheetUri(sheet), name: sheet.span, mimeType: "image/png" }
    ]
  )

const tool = (op: AnyOperation, config: ServerConfig): ToolSpec<KymoServices> => {
  const input = flatInputSchema(op)
  const withImages = op.images !== undefined
  return {
    name: `kymo_${op.name}`,
    title: op.title,
    description: description(op, config),
    inputSchema: withImages
      ? { ...input, properties: { ...input.properties, images: jsonSchema(ImagesMode) } }
      : input,
    outputSchema: jsonSchema(op.output),
    readOnly: op.readOnly,
    openWorld: !op.readOnly,
    ...(config.toolExamples === "on" ? { meta: { "kymo/examples": op.examples } } : {}),
    handle: (args) =>
      Effect.gen(function* () {
        const { images, input: raw } = withImages
          ? yield* splitImages(args)
          : { images: "inline" as const, input: args ?? {} }
        const decoded = yield* decodeInput(op, raw)
        const output = yield* op.run(decoded)
        const json = yield* encodeOutput(op, output)
        const pictures = yield* Effect.forEach(op.images?.(output) ?? [], (s) => sheetContent(s, images))
        return { content: [fallback(json, config), ...pictures.flat()], structured: json, isError: false }
      }).pipe(Effect.catchCause(recover))
  }
}

const SAFE_HANDLE = /^[A-Za-z_][\w-]*$/
const SAFE_SPAN = /^[\w+-]+(\.[\w+-]+)*$/

const sheetTemplate: ResourceTemplateSpec<KymoServices> = {
  name: "sheet",
  description:
    "A sheet image produced earlier in this session, by handle and span (the `span` of a result's sheet).",
  mimeType: "image/png",
  prefix: "kymo://",
  middle: "/sheet/",
  suffix: ".png",
  params: ["handle", "span"],
  read: (handle, span) =>
    Effect.gen(function* () {
      if (!SAFE_HANDLE.test(handle) || !SAFE_SPAN.test(span))
        return yield* Effect.fail(`kymo://${handle}/sheet/${span}.png is not a sheet address.`)
      const output = yield* OutputDir
      const root = yield* Effect.mapError(output.root, (e) => e.message)
      const bytes = yield* Effect.tryPromise({
        try: () => readFile(join(root, handle, `${span}.png`)),
        catch: () => `No sheet ${span} for ${handle} in this session. Call kymo_frames to draw it.`
      })
      return { mimeType: "image/png", bytes: new Uint8Array(bytes) }
    })
}

const frameTemplate: ResourceTemplateSpec<KymoServices> = {
  name: "frame",
  description:
    "One labelled frame of an open source, e.g. kymo://clip1/frame/08s10f.png. Same as kymo_frames with one address.",
  mimeType: "image/png",
  prefix: "kymo://",
  middle: "/frame/",
  suffix: ".png",
  params: ["handle", "address"],
  read: (handle, address) =>
    Effect.gen(function* () {
      const input = yield* decodeInput(frames, { source: handle, at: [address], separate: true })
      const output = yield* frames.run(input)
      const sheet = output.sheets[0]!
      const bytes = yield* Effect.promise(() => readFile(sheet.path))
      return { mimeType: "image/png", bytes: new Uint8Array(bytes) }
    }).pipe(Effect.mapError((e) => `${e.message} ${e.hint}`))
}

export const INSTRUCTIONS = `kymo lets you see and measure motion. Every frame has one address (08s10f, #250, -1f, @impact1+5f, ranges 2s..4s:2f) and the same address appears in image labels, JSON and file names, so pass back exactly what you see.
The loop: kymo_probe a source (cheap, no images) → kymo_scan with a small budget for an overview and suggested ranges → kymo_frames at the addresses that matter (sheet, onion, diff, follow, grid) → kymo_track or kymo_check for numbers (prefer them over reading positions off pixels) → kymo_compare before and after a change, and rerun the same kymo_check assertions to prove it.
Errors come back as results with a tag, message and hint; fix the input as the hint says rather than retrying the same call.`

/** The kymo MCP server: seven tools from the kymo operations, plus sheet and frame resources. */
export const serverSpec = (config: ServerConfig, version: string): ServerSpec<KymoServices> => ({
  name: "kymo",
  version,
  instructions: INSTRUCTIONS,
  tools: toolOperations.map((op) => tool(op, config)),
  templates: [sheetTemplate, frameTemplate]
})
