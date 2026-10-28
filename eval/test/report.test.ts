import { assert, describe, it } from "@effect/vitest"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { DEFAULT_SERVER_CONFIG, fromEnv, toEnv } from "kymo"
import { EXPERIMENTS, type Experiment } from "../src/Experiments.ts"
import type { TaskRun } from "../src/Loop.ts"
import { emptyMetrics } from "../src/Metrics.ts"
import { oracle } from "../src/models/Oracle.ts"
import { markdown, rows } from "../src/Report.ts"
import { runExperiment } from "../src/Runner.ts"
import type { Task } from "../src/Task.ts"
import { SOURCE, checkResult, fakeServer, flickerFinding, text } from "./fake-server.ts"

const run = (over: Partial<TaskRun>): TaskRun => ({
  taskId: "t",
  family: "flicker",
  split: "dev",
  model: "m",
  source: "s",
  stop: "answered",
  error: null,
  pass: true,
  frameError: 0,
  steps: [],
  calls: [],
  metrics: emptyMetrics,
  ...over
})

describe("report", () => {
  const variants = [
    {
      variant: "a",
      runs: [
        run({
          taskId: "t1",
          frameError: 0,
          metrics: {
            ...emptyMetrics,
            imagesSent: 2,
            visualTokens: 100,
            inputTokens: 900,
            outputTokens: 100,
            toolCalls: 3,
            wallMs: 2000
          }
        }),
        run({
          taskId: "t2",
          pass: false,
          frameError: 4,
          metrics: { ...emptyMetrics, toolCalls: 1, toolErrors: 1, wallMs: 1000 }
        }),
        run({
          taskId: "t3",
          split: "heldout",
          family: "cut",
          frameError: null,
          stop: "call-limit",
          pass: false
        })
      ]
    }
  ]

  it("aggregates per variant and split: accuracy, means per task, frame error over readable answers", () => {
    const [dev, heldout] = rows(variants)
    assert.deepInclude(dev!, {
      variant: "a",
      split: "dev",
      tasks: 2,
      accuracy: 0.5,
      meanFrameError: 2,
      images: 1,
      visualTokens: 50,
      totalTokens: 500,
      calls: 2,
      toolErrors: 0.5,
      seconds: 1.5
    })
    assert.deepInclude(heldout!, { split: "heldout", tasks: 1, accuracy: 0, meanFrameError: null })
    assert.deepStrictEqual(heldout!.stops, { "call-limit": 1 })
  })

  it("renders dev and held-out tables separately, with per-family accuracy and failures", () => {
    const md = markdown(
      { experiment: "target", question: "Q?", model: "oracle", startedAt: "now", maxCalls: 20 },
      variants
    )
    const dev = md.indexOf("## Dev")
    const held = md.indexOf("## Held out")
    assert.isTrue(dev > 0 && held > dev)
    assert.include(md, "| a | 2 | 50% | 2.00 | 1.0 | 50 | 500 | 2.0 | 0.50 | 0.00 | 1.5 |")
    assert.include(md, "| Variant | cut | flicker |")
    assert.include(md, "| a | 0/1 | 1/2 |")
    assert.include(md, "| t3 | a | heldout | call-limit |")
  })
})

describe("experiments", () => {
  it("have unique names and unique variant names within each", () => {
    assert.strictEqual(new Set(EXPERIMENTS.map((e) => e.name)).size, EXPERIMENTS.length)
    for (const e of EXPERIMENTS)
      assert.strictEqual(new Set(e.variants.map((v) => v.name)).size, e.variants.length, e.name)
  })
  it("cover the spec's checklist", () => {
    assert.includeMembers(
      EXPERIMENTS.map((e) => e.name),
      ["target", "cells", "label-style", "onion-vs-sheet", "sampling", "tool-examples", "text-fallback"]
    )
  })
  it("never compare identical arms: every two variants differ in server config or pinned arguments", () => {
    for (const e of EXPERIMENTS)
      e.variants.forEach((a, i) =>
        e.variants
          .slice(i + 1)
          .forEach((b) =>
            assert.notDeepEqual(
              { config: a.config, pin: a.pin },
              { config: b.config, pin: b.pin },
              `${e.name}: ${a.name} and ${b.name} are the same arm`
            )
          )
      )
  })
  it.effect("start servers with configs the server reads back exactly", () =>
    Effect.forEach(
      EXPERIMENTS.flatMap((e) => e.variants),
      (v) => Effect.map(fromEnv(toEnv(v.config)), (read) => assert.deepStrictEqual(read, v.config, v.name))
    )
  )
})

describe("runner", () => {
  it.effect("runs every variant against its own server and writes jsonl, results.json and summary.md", () =>
    Effect.gen(function* () {
      const outDir = join(mkdtempSync(join(tmpdir(), "kymo-run-")), "run")
      const task = (id: string, split: Task["split"]): Task => ({
        id,
        split,
        source: "fake-clip",
        clock: { rate: { num: 30, den: 1 }, frames: 90 },
        givens: { _tag: "flicker" },
        prompt: "When?",
        answer: { _tag: "frame", index: 45, tolerance: 0 },
        followUps: []
      })
      const experiment: Experiment = {
        name: "examples",
        question: "Q?",
        variants: [
          { name: "on", config: DEFAULT_SERVER_CONFIG, pin: {} },
          {
            name: "off",
            config: { ...DEFAULT_SERVER_CONFIG, toolExamples: "off" },
            pin: { kymo_check: { rules: ["flicker"] } }
          }
        ]
      }
      const envs: Array<string | undefined> = []
      const result = yield* runExperiment({
        experiment,
        model: oracle,
        tasks: [task("a", "dev"), task("b", "heldout")],
        system: "s",
        maxCalls: 5,
        concurrency: 2,
        cacheDir: join(outDir, "cache"),
        outDir,
        startedAt: "2026-10-28T00:00:00Z",
        connect: (variant) => {
          envs.push(variant.config.toolExamples)
          return fakeServer([
            { name: "kymo_probe", properties: SOURCE, handle: () => ({ content: [text("probe")] }) },
            {
              name: "kymo_check",
              properties: { ...SOURCE, rules: { type: "array" } },
              handle: () => ({
                content: [text("found")],
                structuredContent: checkResult([flickerFinding(45)])
              })
            }
          ])
        },
        progress: () => undefined
      })
      assert.deepStrictEqual(envs, ["on", "off"])
      assert.deepStrictEqual(
        result.variants.map((v) => v.runs.map((r) => r.pass)),
        [
          [true, true],
          [true, true]
        ]
      )
      assert.strictEqual(readFileSync(join(outDir, "runs.jsonl"), "utf8").trim().split("\n").length, 4)
      const saved = JSON.parse(readFileSync(result.resultsPath, "utf8")) as {
        summary: Array<{ variant: string; split: string }>
      }
      assert.deepStrictEqual(
        saved.summary.map((r) => `${r.variant}/${r.split}`),
        ["on/dev", "off/dev", "on/heldout", "off/heldout"]
      )
      assert.isTrue(existsSync(result.summaryPath))
      assert.include(readFileSync(result.summaryPath, "utf8"), "# examples: oracle")
    }).pipe(Effect.scoped)
  )
})
