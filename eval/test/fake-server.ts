/**
 * A real MCP server with canned tools, connected over an in-memory transport. The harness talks to it
 * through the same MCP client path it uses for `kymo mcp`, so tests cover the protocol translation.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Address, frameIndex, rate } from "@kymo/core"
import { type CheckFinding, CheckOutput, ProbeOutput, TrackOutput } from "kymo"
import { Effect, Schema } from "effect"
import sharp from "sharp"
import { connect } from "../src/Tools.ts"

export interface FakeResult {
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  >
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
}

export interface FakeTool {
  readonly name: string
  readonly properties: Record<string, unknown>
  readonly handle: (args: Record<string, unknown>) => FakeResult
}

/** Every call the server received, in order. */
export type CallLog = Array<{ readonly name: string; readonly args: Record<string, unknown> }>

export const fakeServer = (tools: ReadonlyArray<FakeTool>, log: CallLog = []) =>
  Effect.gen(function* () {
    const server = new Server({ name: "kymo", version: "0.0.0" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: `fake ${t.name}`,
        inputSchema: { type: "object" as const, properties: t.properties, required: ["source"] }
      }))
    }))
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      const args = request.params.arguments ?? {}
      log.push({ name: request.params.name, args })
      const tool = tools.find((t) => t.name === request.params.name)
      if (!tool) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ tag: "InvalidInput", message: "no such tool", hint: "" })
            }
          ]
        }
      }
      const result = tool.handle(args)
      return { ...result, content: [...result.content] }
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    yield* Effect.promise(() => server.connect(serverSide))
    yield* Effect.addFinalizer(() => Effect.promise(() => server.close()))
    return yield* connect(clientSide)
  })

/** A solid PNG of the given size, base64. */
export const png = (width: number, height: number) =>
  Effect.promise(() =>
    sharp({ create: { width, height, channels: 3, background: { r: 40, g: 40, b: 40 } } })
      .png()
      .toBuffer()
      .then((b) => b.toString("base64"))
  )

export const text = (value: unknown) => ({
  type: "text" as const,
  text: typeof value === "string" ? value : JSON.stringify(value)
})

export const SOURCE = { source: { type: "string" } }

/**
 * `structuredContent` exactly as the real op encodes it. Fakes build results through these, so a
 * change to an op's output schema breaks the fake at compile time instead of drifting from it.
 */
export const structured = {
  check: (value: typeof CheckOutput.Type) => Schema.encodeSync(CheckOutput)(value) as Record<string, unknown>,
  probe: (value: typeof ProbeOutput.Type) => Schema.encodeSync(ProbeOutput)(value) as Record<string, unknown>,
  track: (value: typeof TrackOutput.Type) => Schema.encodeSync(TrackOutput)(value) as Record<string, unknown>
}

/** A flicker finding at `index` (30 fps clock), as `kymo_check` reports it. */
export const flickerFinding = (index: number): CheckFinding => ({
  rule: "flicker",
  severity: "error",
  address: Address.format(rate(30), index),
  index: frameIndex(index),
  message: "flash",
  suggest: {
    tool: "kymo_frames",
    arguments: { source: "s", at: [Address.format(rate(30), index)], view: "diff" },
    command: `kymo frames s --at ${Address.format(rate(30), index)} --view diff`
  }
})

export const checkResult = (findings: ReadonlyArray<CheckFinding>) =>
  structured.check({
    handle: "s",
    range: "0f..02s29f",
    rules: ["flicker"],
    findings,
    assertions: [],
    pass: false,
    counts: { error: findings.length, warning: 0, info: 0 },
    label: `Fail: 0 warnings, ${findings.length} errors, 0 info; no assertions.`
  })
