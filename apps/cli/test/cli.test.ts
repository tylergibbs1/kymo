import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { jsonSchema, operations } from "kymo"
import { Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const BIN = resolve(import.meta.dirname, "../bin/kymo.js")

let dir = ""
let clip = ""

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kymo-cli-"))
  clip = join(dir, "clip.mp4")
  execFileSync("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:duration=2",
    "-pix_fmt",
    "yuv420p",
    clip
  ])
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface Run {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** The real binary, in a scratch working directory so handles stay out of the repo. */
const kymo = (...args: Array<string>): Promise<Run> =>
  new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: dir })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
    child.on("close", (code) => done({ code, stdout, stderr }))
  })

const jsonLines = (text: string): Array<Record<string, unknown>> =>
  text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe("kymo CLI", () => {
  it("probe prints the Timeline of a video as one JSON value", async () => {
    const r = await kymo("probe", clip)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe("")
    const timeline = JSON.parse(r.stdout) as Record<string, unknown>
    expect(timeline).toMatchObject({
      kind: "video",
      input: clip,
      fps: 30,
      frameCount: 60,
      duration: "02s",
      size: { width: 160, height: 90 }
    })
    expect(typeof timeline["handle"]).toBe("string")
  })

  it("frames --at 0f 1s -1f writes PNGs named by address, one JSON line each", async () => {
    const out = join(dir, "separate")
    const r = await kymo("frames", clip, "--at", "0f", "1s", "-1f", "--separate", "--out", out)
    expect(r.code).toBe(0)
    const lines = jsonLines(r.stdout)
    const sheets = lines.slice(0, -1)
    expect(sheets.map((s) => s["label"])).toEqual([
      "Frame 1 of 3 · clip1 · 0f #0",
      "Frame 2 of 3 · clip1 · 01s #30",
      "Frame 3 of 3 · clip1 · 01s29f #59"
    ])
    expect(readdirSync(join(out, "clip1")).sort()).toEqual(["01s.png", "01s29f.png", "0f.png"])
    for (const s of sheets) expect(existsSync(s["path"] as string)).toBe(true)
    expect(lines.at(-1)).toMatchObject({ handle: "clip1", view: "sheet", next: null })
  })

  it("a bad address exits 2 with an AddressParseError on stderr and nothing on stdout", async () => {
    const r = await kymo("frames", clip, "--at", "8s10")
    expect(r.code).toBe(2)
    expect(r.stdout).toBe("")
    const error = JSON.parse(r.stderr) as Record<string, string>
    expect(error["tag"]).toBe("AddressParseError")
    expect(error["message"]).toContain('"8s10" is not an address. Use 08s10f')
    expect(error["hint"]).toContain("08s10f")
  })

  it("an unknown flag or command exits 2 with JSON and no guesses", async () => {
    for (const args of [
      ["frames", clip, "--bogus", "1"],
      ["framez", clip]
    ]) {
      const r = await kymo(...args)
      expect(r.code).toBe(2)
      expect(r.stdout).toBe("")
      const error = JSON.parse(r.stderr) as Record<string, string>
      expect(error["tag"]).toBe("InvalidInput")
      expect(`${error["message"]} ${error["hint"]}`).not.toMatch(/did you mean/i)
    }
    const r = await kymo("scan", clip, "--budget", "lots")
    expect(r.code).toBe(2)
    expect(JSON.parse(r.stderr)).toMatchObject({ tag: "InvalidInput" })
  })

  it("--json takes the whole input and matches the equivalent flags", async () => {
    const out = join(dir, "same")
    const flags = await kymo(
      "frames",
      "synthetic:bounce?impact=20",
      "--at",
      "0f",
      "@impact1",
      "--view",
      "grid",
      "--out",
      out
    )
    const json = await kymo(
      "frames",
      "--json",
      JSON.stringify({ source: "synthetic:bounce?impact=20", at: ["0f", "@impact1"], view: "grid" }),
      "--out",
      out
    )
    expect(flags.code).toBe(0)
    expect(json.stdout).toBe(flags.stdout)
    const overridden = await kymo("probe", "--json", JSON.stringify({ source: "nope.mp4" }), "synthetic:cut")
    expect(JSON.parse(overridden.stdout)).toMatchObject({ input: "synthetic:cut" })
  })

  it("check prints one line per finding, then the summary", async () => {
    const r = await kymo("check", "synthetic:flicker?at=40", "--rules", "flicker", "black-frames")
    expect(r.code).toBe(0)
    const lines = jsonLines(r.stdout)
    expect(lines[0]).toMatchObject({ rule: "flicker", address: "01s10f" })
    expect(lines.at(-1)).toMatchObject({ rules: ["flicker", "black-frames"], pass: false })
  })

  /** One input per JSON Lines command; a new JSON Lines command fails the test below until it has one. */
  const LINES_INPUTS: Readonly<Record<string, Record<string, unknown>>> = {
    frames: { source: "synthetic:bounce?impact=20", range: "0f..-1f:3f", target: "standard" },
    compare: { a: "synthetic:ease?easing=linear", b: "synthetic:ease?easing=ease-out", at: ["0f", "1s"] },
    check: { source: "synthetic:dropped?dups=5,50,51,52", assert: ["motion >= 0"] }
  }

  it("every JSON Lines command prints lines that decode with the line and summary schemas it publishes", async () => {
    const streamed = operations.filter((op) => op.lines !== undefined)
    expect(streamed.map((op) => op.name).sort()).toEqual(Object.keys(LINES_INPUTS).sort())
    const strict = { onExcessProperty: "error" } as const
    for (const op of streamed) {
      const { field, line, summary } = op.lines!
      const published = JSON.parse((await kymo("schema", op.name)).stdout) as Record<string, unknown>
      expect(published["lines"]).toEqual({ field, line: jsonSchema(line), summary: jsonSchema(summary) })
      const json = JSON.stringify(LINES_INPUTS[op.name])
      const r = await kymo(op.name, "--json", json, "--out", join(dir, "lines"))
      expect(r.code, r.stderr).toBe(0)
      const lines = jsonLines(r.stdout)
      expect(lines.length, op.name).toBeGreaterThan(1)
      for (const l of lines.slice(0, -1))
        expect(() => Schema.decodeUnknownSync(line)(l, strict)).not.toThrow()
      expect(() => Schema.decodeUnknownSync(summary)(lines.at(-1), strict)).not.toThrow()
    }
  })

  it("record is unavailable with its own exit code", async () => {
    const r = await kymo("record", "screen", "--duration", "5s")
    expect(r.code).toBe(4)
    expect(JSON.parse(r.stderr)).toMatchObject({ tag: "AdapterUnavailable" })
  })

  it("schema --all prints valid input and output JSON Schemas for every command", async () => {
    const r = await kymo("schema", "--all")
    expect(r.code).toBe(0)
    const all = JSON.parse(r.stdout) as Record<
      string,
      { input: Record<string, unknown>; output: Record<string, unknown> }
    >
    expect(Object.keys(all)).toEqual([
      "open",
      "probe",
      "scan",
      "frames",
      "compare",
      "track",
      "check",
      "record"
    ])
    for (const { input, output } of Object.values(all)) {
      expect(input["type"] ?? input["anyOf"]).toBeDefined()
      expect(output["type"]).toBe("object")
    }
    const one = JSON.parse((await kymo("schema", "frames")).stdout) as Record<string, unknown>
    expect(Object.keys(one)).toEqual(["input", "output", "lines"])
    const plain = JSON.parse((await kymo("schema", "probe")).stdout) as Record<string, unknown>
    expect(Object.keys(plain)).toEqual(["input", "output"])
  })
})
