import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { CheckOutput, FramesOutput, ProbeOutput } from "kymo"
import { Schema } from "effect"
import { McpProtocol } from "effect/ai"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const BIN = resolve(import.meta.dirname, "../../cli/bin/kymo.js")

type Block = { readonly type: string; readonly text?: string; readonly data?: string; readonly uri?: string }

const dirs: Array<string> = []

/** `kymo mcp` as a real subprocess, spoken to by the official MCP client over stdio. */
const connect = async (env: Record<string, string> = {}) => {
  const cwd = mkdtempSync(join(tmpdir(), "kymo-mcp-"))
  dirs.push(cwd)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp"],
    cwd,
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: "pipe"
  })
  const client = new Client({ name: "kymo-test", version: "0.0.0" })
  await client.connect(transport)
  return client
}

/**
 * One `initialize` over raw stdio, without the SDK (which only offers its own latest version), and
 * the server's JSON-RPC answer.
 */
const rawInitialize = (protocolVersion: string): Promise<Record<string, unknown>> =>
  new Promise((done, fail) => {
    const cwd = mkdtempSync(join(tmpdir(), "kymo-mcp-"))
    dirs.push(cwd)
    const child = spawn(process.execPath, [BIN, "mcp"], { cwd, stdio: ["pipe", "pipe", "pipe"] })
    let out = ""
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error(`no answer to initialize ${protocolVersion}: ${out}`))
    }, 20_000)
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString()
      const line = out.split("\n").find((l) => l.trim().length > 0 && out.includes("\n"))
      if (line === undefined) return
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      done(JSON.parse(line) as Record<string, unknown>)
    })
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "raw", version: "0" } }
    }
    child.stdin.write(`${JSON.stringify(request)}\n`)
  })

let client: Client

beforeAll(async () => {
  client = await connect()
})

afterAll(async () => {
  await client.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const call = async (name: string, args: Record<string, unknown>) => {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }))
  return { ...result, content: result.content as ReadonlyArray<Block> }
}

describe("kymo MCP server", () => {
  it("lists seven tools with honest annotations and output schemas", async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([
      "kymo_probe",
      "kymo_scan",
      "kymo_frames",
      "kymo_compare",
      "kymo_track",
      "kymo_check",
      "kymo_record"
    ])
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object")
      expect(t.outputSchema?.type).toBe("object")
      const record = t.name === "kymo_record"
      expect(t.annotations?.readOnlyHint).toBe(!record)
      expect(t.annotations?.openWorldHint).toBe(record)
    }
    const frames = tools.find((t) => t.name === "kymo_frames")!
    expect(frames.description).toContain("Examples:")
    expect(frames.description).toContain("≤4784 visual tokens")
    expect(Object.keys(frames.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["at", "range", "images"])
    )
  })

  it("probe returns the Timeline as structured content", async () => {
    const r = await call("kymo_probe", { source: "synthetic:bounce?impact=20" })
    expect(r.isError).toBeFalsy()
    const timeline = Schema.decodeUnknownSync(ProbeOutput)(r.structuredContent)
    expect(timeline).toMatchObject({ handle: "clip1", frameCount: 90 })
    expect(JSON.parse(r.content[0]!.text!)).toEqual(r.structuredContent)
  })

  it("frames puts each sheet's label right before its image, then a resource link", async () => {
    const r = await call("kymo_frames", { source: "synthetic:bounce?impact=20", range: "0f..-1f:2f" })
    expect(r.isError).toBeFalsy()
    const output = Schema.decodeUnknownSync(FramesOutput)(r.structuredContent)
    expect(output.sheets.length).toBeGreaterThan(1)
    const types = r.content.map((b) => b.type)
    expect(types).toEqual(["text", ...output.sheets.flatMap(() => ["text", "image", "resource_link"])])
    output.sheets.forEach((sheet, k) => {
      const at = 1 + 3 * k
      expect(r.content[at]!.text).toBe(sheet.label)
      expect(
        Buffer.from(r.content[at + 1]!.data!, "base64")
          .subarray(1, 4)
          .toString()
      ).toBe("PNG")
      expect(r.content[at + 2]!.uri).toBe(`kymo://clip1/sheet/${sheet.span}.png`)
    })
    const resource = await client.readResource({ uri: r.content[3]!.uri! })
    expect(resource.contents[0]).toMatchObject({ mimeType: "image/png" })
  })

  it("links-only results carry no image data", async () => {
    const r = await call("kymo_frames", { source: "synthetic:bounce?impact=20", at: ["0f"], images: "links" })
    expect(r.content.map((b) => b.type)).toEqual(["text", "text", "resource_link"])
  })

  it("a bad address is an isError result with the hint, not a protocol error", async () => {
    const r = await call("kymo_frames", { source: "synthetic:bounce?impact=20", at: ["8s10"] })
    expect(r.isError).toBe(true)
    const error = JSON.parse(r.content[0]!.text!) as Record<string, string>
    expect(error["tag"]).toBe("AddressParseError")
    expect(error["message"]).toContain('"8s10" is not an address')
    expect(error["hint"]).toContain("08s10f")
    const record = await call("kymo_record", { source: "screen", duration: "5s" })
    expect(record.isError).toBe(true)
    expect(JSON.parse(record.content[0]!.text!)).toMatchObject({ tag: "AdapterUnavailable" })
  })

  it("serves single frames as resources, by any address form", async () => {
    const frame = await client.readResource({ uri: "kymo://clip1/frame/1s.png" })
    expect(frame.contents[0]).toMatchObject({ uri: "kymo://clip1/frame/1s.png", mimeType: "image/png" })
    const byIndex = await client.readResource({ uri: "kymo://clip1/frame/%2320.png" })
    expect(byIndex.contents[0]).toMatchObject({ mimeType: "image/png" })
    await expect(client.readResource({ uri: "kymo://clip1/frame/%23250.png" })).rejects.toThrow(
      /past the end/
    )
  })

  it("KYMO_TOOL_EXAMPLES=off removes the examples and nothing else", async () => {
    const plain = await connect({ KYMO_TOOL_EXAMPLES: "off" })
    const { tools } = await plain.listTools()
    await plain.close()
    for (const t of tools) {
      expect(t.description).not.toContain("Examples:")
      expect(t._meta?.["kymo/examples"]).toBeUndefined()
    }
    const withExamples = (await client.listTools()).tools
    expect(tools.map((t) => t.inputSchema)).toEqual(withExamples.map((t) => t.inputSchema))
  })

  const AT = { source: "synthetic:bounce?impact=20", at: ["0f", "1s", "-1f"] }

  /** One call on a server started with `env`, closed afterwards. */
  const callWith = async (env: Record<string, string>, name: string, args: Record<string, unknown>) => {
    const other = await connect(env)
    const result = CallToolResultSchema.parse(await other.callTool({ name, arguments: args }))
    const { tools } = await other.listTools()
    await other.close()
    return { ...result, content: result.content as ReadonlyArray<Block>, tools }
  }

  it("KYMO_LABEL_STYLE=index labels frames #N on images and in text; addresses in JSON stay the same", async () => {
    const plain = await call("kymo_frames", AT)
    const index = await callWith({ KYMO_LABEL_STYLE: "index" }, "kymo_frames", AT)
    expect(index.isError).toBeFalsy()
    expect(plain.content[1]!.text).toBe("Sheet 1 of 1 · clip1 · 0f–02s29f · 3 frames, uneven spacing")
    expect(index.content[1]!.text).toBe("Sheet 1 of 1 · clip1 · #0–#89 · 3 frames, uneven spacing")
    expect(index.content[2]!.data).not.toBe(plain.content[2]!.data)
    const frames = (r: { structuredContent?: unknown }) =>
      Schema.decodeUnknownSync(FramesOutput)(r.structuredContent).frames
    expect(frames(index)).toEqual(frames(plain))
    expect(frames(index).map((f) => f.address)).toEqual(["0f", "01s", "02s29f"])
    const description = index.tools.find((t) => t.name === "kymo_frames")!.description
    expect(description).toContain("Labels show `#250`")
  })

  it("KYMO_LABEL_STYLE=index labels frames #N in check messages; address and index stay the same", async () => {
    const args = {
      source: "synthetic:flicker?at=40",
      rules: ["flicker"],
      assert: ["@flicker within #38..#42"]
    }
    const result = (r: { structuredContent?: unknown }) =>
      Schema.decodeUnknownSync(CheckOutput)(r.structuredContent)
    const plain = result(await call("kymo_check", args))
    const index = result(await callWith({ KYMO_LABEL_STYLE: "index" }, "kymo_check", args))
    const timecode = result(await callWith({ KYMO_LABEL_STYLE: "timecode" }, "kymo_check", args))
    const [finding] = index.findings
    expect(finding).toMatchObject({ rule: "flicker", address: "01s10f", index: 40 })
    expect(finding!.message).toMatch(/^#40 is brighter/)
    expect(plain.findings[0]!.message).toMatch(/^01s10f #40 is brighter/)
    expect(timecode.findings[0]!.message).toMatch(/^01s10f is brighter/)
    expect(index.assertions[0]!.message).toBe("@flicker is at #40, within #38..#42.")
    expect(index.assertions[0]!.address).toBe(plain.assertions[0]!.address)
    // Only the prose changes: what an agent passes back is the same in every style.
    const addresses = (f: (typeof CheckOutput.Type)["findings"][number]) => [
      f.address,
      f.index,
      f.span,
      f.suggest.arguments.at
    ]
    expect(addresses(finding!)).toEqual(addresses(plain.findings[0]!))
  })

  it("KYMO_TEXT_FORMAT=markdown changes only the text block next to structuredContent", async () => {
    const withoutPaths = (v: unknown): unknown =>
      JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === "path" ? undefined : x)))
    const plain = await call("kymo_frames", AT)
    const md = await callWith({ KYMO_TEXT_FORMAT: "markdown" }, "kymo_frames", AT)
    expect(md.isError).toBeFalsy()
    expect(withoutPaths(md.structuredContent)).toEqual(withoutPaths(plain.structuredContent))
    expect(md.content.slice(1)).toEqual(plain.content.slice(1))
    const text = md.content[0]!.text!
    expect(() => JSON.parse(text) as unknown).toThrow()
    expect(text).toContain("**handle**: clip1")
    expect(text).toContain("| address | index |")
    expect(text).toContain("| 01s | 30 |")
  })

  it("answers initialize with the protocol version the client asked for, when it supports it", async () => {
    // Every version Effect has an adapter for; 2026-07-28 is stateless and has no initialize.
    const versions = Object.entries(McpProtocol)
      .filter(([name]) => /^v\d{4}_\d{2}_\d{2}$/.test(name))
      .map(([, adapter]) => (adapter as { readonly protocolVersion: string }).protocolVersion)
      .filter((v) => v !== "2026-07-28")
    expect(versions).toContain("2025-06-18")
    for (const asked of versions) {
      const answer = await rawInitialize(asked)
      expect(answer, asked).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: asked, serverInfo: { name: "kymo" } }
      })
    }
  })

  it("an invalid switch fails at startup, naming the valid values", () => {
    const run = spawnSync(process.execPath, [BIN, "mcp"], {
      env: { ...process.env, KYMO_LABEL_STYLE: "frames" },
      input: "",
      encoding: "utf8",
      timeout: 20_000
    })
    expect(run.status).not.toBe(0)
    expect(run.stdout).toBe("")
    const error = JSON.parse(run.stderr) as Record<string, string>
    expect(error["tag"]).toBe("InvalidInput")
    expect(error["message"]).toBe('KYMO_LABEL_STYLE="frames" is not valid; use both, timecode, index.')
  })
})
