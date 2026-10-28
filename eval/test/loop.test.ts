import { assert, describe, it } from "@effect/vitest"
import type Anthropic from "@anthropic-ai/sdk"
import { Effect } from "effect"
import { runTask } from "../src/Loop.ts"
import { imageCost } from "../src/Metrics.ts"
import type { Input, ModelBackend, Turn } from "../src/Model.ts"
import { anthropic } from "../src/models/Anthropic.ts"
import { oracle } from "../src/models/Oracle.ts"
import { pin } from "../src/Pin.ts"
import type { Task } from "../src/Task.ts"
import type { ToolBackend, ToolCall } from "../src/Tools.ts"
import {
  type CallLog,
  type FakeTool,
  SOURCE,
  checkResult,
  fakeServer,
  flickerFinding,
  png,
  text
} from "./fake-server.ts"

const flickerTask: Task = {
  id: "flicker-test",
  split: "dev",
  source: "fake-clip",
  clock: { rate: { num: 30, den: 1 }, frames: 90 },
  givens: { _tag: "flicker" },
  prompt: "At which frame does the flicker happen?",
  answer: { _tag: "frame", index: 45, tolerance: 0 },
  followUps: []
}

/** A model that plays back fixed turns, recording what it was sent. */
const scripted = (turns: ReadonlyArray<Partial<Turn>>, seen: Array<Input> = []): ModelBackend => ({
  id: "scripted",
  start: () =>
    Effect.sync(() => {
      let k = 0
      return {
        send: (input) =>
          Effect.sync(() => {
            seen.push(input)
            const t = turns[Math.min(k++, turns.length - 1)]!
            return {
              text: "",
              calls: [],
              usage: { inputTokens: 100, outputTokens: 10 },
              refused: false,
              ...t
            }
          })
      }
    })
})

const call = (
  name: string,
  args: Record<string, unknown> = { source: "fake-clip" },
  id = name
): ToolCall => ({ id, name, args })

const kymoTools = (image: string): ReadonlyArray<FakeTool> => [
  {
    name: "kymo_probe",
    properties: SOURCE,
    handle: () => ({
      content: [text({ size: { width: 640, height: 360 } })],
      structuredContent: { handle: "s", size: { width: 640, height: 360 } }
    })
  },
  {
    name: "kymo_frames",
    properties: { ...SOURCE, at: { type: "array" }, target: { type: "string" } },
    handle: (args) =>
      args["at"] === undefined
        ? {
            isError: true,
            content: [text({ tag: "InvalidInput", message: "at or range is required", hint: 'at=["1s"]' })]
          }
        : {
            content: [text("1s #30"), { type: "image", data: image, mimeType: "image/png" }],
            structuredContent: { frames: [{ address: "1s", index: 30, t: 1 }] }
          }
  },
  {
    name: "kymo_check",
    properties: { ...SOURCE, rules: { type: "array" } },
    handle: () => {
      const structuredContent = checkResult([flickerFinding(45)])
      return { content: [text(structuredContent)], structuredContent }
    }
  }
]

const withServer = <A, E>(f: (tools: ToolBackend, log: CallLog, image: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const image = yield* png(100, 60)
    const log: CallLog = []
    const tools = yield* fakeServer(kymoTools(image), log)
    return yield* f(tools, log, image)
  }).pipe(Effect.scoped)

const options = { system: "test", maxCalls: 5 }

describe("agent loop", () => {
  it.effect("tool call → result → answer, with the cost of every image accounted", () =>
    withServer((tools) =>
      Effect.gen(function* () {
        const seen: Array<Input> = []
        const model = scripted(
          [
            { calls: [call("kymo_probe"), call("kymo_frames", { source: "fake-clip", at: ["1s"] })] },
            { text: "It flashes.\nANSWER: 01s15f" }
          ],
          seen
        )
        const run = yield* runTask({ task: flickerTask, source: "fake-clip", model, tools, options })
        assert.strictEqual(run.stop, "answered")
        assert.isTrue(run.pass)
        assert.strictEqual(run.frameError, 0)
        // 100×60 px → ⌈100/28⌉ × ⌈60/28⌉ = 4 × 3 tiles.
        assert.deepInclude(run.metrics, {
          imagesSent: 1,
          visualTokens: 12,
          toolCalls: 2,
          toolErrors: 0,
          retries: 0,
          inputTokens: 200,
          outputTokens: 20
        })
        // The model got both results back in one message, label before image, structured content intact.
        const results = seen[1]
        assert.strictEqual(results?._tag, "results")
        if (results?._tag === "results") {
          assert.deepStrictEqual(
            results.results[1]!.outcome.blocks.map((b) => b._tag),
            ["text", "image"]
          )
          assert.deepStrictEqual(results.results[1]!.outcome.structured, {
            frames: [{ address: "1s", index: 30, t: 1 }]
          })
        }
        assert.include((seen[0] as { text: string }).text, "`fake-clip`")
      })
    )
  )

  it.effect("counts tool errors and the retry that follows one", () =>
    withServer((tools) =>
      Effect.gen(function* () {
        const model = scripted([
          { calls: [call("kymo_frames")] },
          { calls: [call("kymo_frames", { source: "fake-clip", at: ["1s"] })] },
          { text: "ANSWER: #44" }
        ])
        const run = yield* runTask({ task: flickerTask, source: "fake-clip", model, tools, options })
        assert.deepInclude(run.metrics, { toolCalls: 2, toolErrors: 1, retries: 1, imagesSent: 1 })
        assert.include(run.calls[0]!.error, "InvalidInput")
        assert.deepInclude(run, { pass: false, frameError: 1 })
      })
    )
  )

  it.effect("stops at the call limit without making the call that would exceed it", () =>
    withServer((tools, log) =>
      Effect.gen(function* () {
        const model = scripted([{ calls: [call("kymo_probe")] }])
        const run = yield* runTask({
          task: flickerTask,
          source: "fake-clip",
          model,
          tools,
          options: { ...options, maxCalls: 3 }
        })
        assert.deepInclude(run, { stop: "call-limit", pass: false })
        assert.strictEqual(log.length, 3)
        assert.strictEqual(run.metrics.toolCalls, 3)
      })
    )
  )

  it.effect("asks follow-up questions in the same conversation and passes only if all pass", () =>
    withServer((tools) =>
      Effect.gen(function* () {
        const task: Task = {
          ...flickerTask,
          followUps: [{ prompt: "How many flickers?", answer: { _tag: "count", value: 1 } }]
        }
        const seen: Array<Input> = []
        const model = scripted([{ text: "ANSWER: #45" }, { text: "ANSWER: 2" }], seen)
        const run = yield* runTask({ task, source: "fake-clip", model, tools, options })
        assert.deepStrictEqual(seen[1], { _tag: "user", text: "How many flickers?" })
        assert.deepStrictEqual(
          run.steps.map((s) => s.score.pass),
          [true, false]
        )
        assert.isFalse(run.pass)
      })
    )
  )

  it.effect("a model failure ends the run with a reason instead of failing the experiment", () =>
    withServer((tools) =>
      Effect.gen(function* () {
        const failing = anthropic({
          model: "claude-test",
          effort: "low",
          maxTokens: 1024,
          client: { messages: { create: () => Promise.reject(new Error("overloaded")) } } as unknown as Pick<
            Anthropic,
            "messages"
          >
        })
        const run = yield* runTask({ task: flickerTask, source: "fake-clip", model: failing, tools, options })
        assert.deepInclude(run, { stop: "model-error", pass: false, error: "overloaded" })
      })
    )
  )
})

describe("scripted oracle", () => {
  it.effect("follows probe → check and answers from structuredContent", () =>
    withServer((tools, log) =>
      Effect.gen(function* () {
        const run = yield* runTask({ task: flickerTask, source: "fake-clip", model: oracle, tools, options })
        assert.deepStrictEqual(
          log.map((c) => c.name),
          ["kymo_probe", "kymo_check"]
        )
        assert.deepStrictEqual(log[1]!.args, { source: "fake-clip", rules: ["flicker"] })
        assert.isTrue(run.pass, run.steps[0]?.reply)
      })
    )
  )

  it.effect("says why when the server lacks a tool its strategy needs", () =>
    withServer((tools) =>
      Effect.gen(function* () {
        const task: Task = { ...flickerTask, givens: { _tag: "cut" } }
        const run = yield* runTask({ task, source: "fake-clip", model: oracle, tools, options })
        assert.include(run.steps[0]!.reply, "no kymo_scan tool")
        assert.isFalse(run.pass)
      })
    )
  )
})

describe("pinned arguments", () => {
  it.effect("hide the pinned parameter from the model and override every call", () =>
    withServer((tools, log) =>
      Effect.gen(function* () {
        const pinned = yield* pin(tools, { kymo_frames: { target: "standard" } })
        const frames = pinned.tools.find((t) => t.name === "kymo_frames")!
        assert.notProperty(frames.inputSchema["properties"], "target")
        yield* pinned.call("kymo_frames", { source: "fake-clip", at: ["1s"], target: "high-res" })
        assert.strictEqual(log[0]!.args["target"], "standard")
      })
    )
  )

  it.effect("fail before any task when the server has no such parameter", () =>
    withServer((tools) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(pin(tools, { kymo_scan: { budget: 4 }, kymo_frames: { cells: 9 } }))
        assert.include(error.message, "no tool kymo_scan")
        assert.include(error.message, "kymo_frames has no parameter cells")
      })
    )
  )
})

describe("Anthropic adapter", () => {
  it.effect("sends MCP images as image blocks inside tool_result and sums usage including cache", () =>
    withServer((tools, _log, image) =>
      Effect.gen(function* () {
        const requests: Array<Anthropic.MessageCreateParamsNonStreaming> = []
        const responses = [
          {
            content: [
              { type: "tool_use", id: "tu1", name: "kymo_frames", input: { source: "fake-clip", at: ["1s"] } }
            ],
            stop_reason: "tool_use",
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 5,
              cache_read_input_tokens: 85,
              output_tokens: 7
            }
          },
          {
            content: [{ type: "text", text: "ANSWER: #45" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 100,
              output_tokens: 3
            }
          }
        ]
        const client = {
          messages: {
            create: (body: Anthropic.MessageCreateParamsNonStreaming) => {
              requests.push(structuredClone(body))
              return Promise.resolve(responses[requests.length - 1])
            }
          }
        } as unknown as Pick<Anthropic, "messages">
        const model = anthropic({ model: "claude-opus-5-5", effort: "high", maxTokens: 4096, client })
        const run = yield* runTask({ task: flickerTask, source: "fake-clip", model, tools, options })
        assert.isTrue(run.pass)
        assert.deepInclude(run.metrics, { inputTokens: 220, outputTokens: 10, imagesSent: 1 })
        const second = requests[1]!
        assert.deepStrictEqual(second.output_config, { effort: "high" })
        assert.deepStrictEqual(
          second.tools?.map((t) => ("name" in t ? t.name : "")),
          ["kymo_probe", "kymo_frames", "kymo_check"]
        )
        const toolResult = (second.messages[2]!.content as Array<Anthropic.ToolResultBlockParam>)[0]!
        assert.strictEqual(toolResult.tool_use_id, "tu1")
        assert.deepStrictEqual(toolResult.content, [
          { type: "text", text: "1s #30" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: image } }
        ])
      })
    )
  )
})

describe("image cost", () => {
  it.effect("is ⌈w/28⌉ × ⌈h/28⌉ per image and ignores text", () =>
    Effect.gen(function* () {
      const a = yield* png(28, 28)
      const b = yield* png(1568, 882)
      const cost = yield* imageCost([
        { _tag: "image", data: a, mimeType: "image/png" },
        { _tag: "text", text: "label" },
        { _tag: "image", data: b, mimeType: "image/png" }
      ])
      assert.deepStrictEqual(cost, { images: 2, tokens: 1 + 56 * 32 })
    })
  )
})
