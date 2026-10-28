import { assert, describe, it } from "@effect/vitest"
import { join } from "node:path"
import { frameIndex } from "@kymo/core"
import { Sources, SyntheticAdapter } from "@kymo/sources"
import { Effect, Layer } from "effect"
import { runTask } from "../src/Loop.ts"
import { oracle } from "../src/models/Oracle.ts"
import { loadTaskFile } from "../src/TaskSet.ts"
import { UI_CASES } from "../src/ui/Cases.ts"
import { type State, boxOf, settleOf, startOf, stutters, turningPoints } from "../src/ui/Measure.ts"
import { generateUi } from "../src/ui/Tasks.ts"
import { type CaptureTruth, captureKey, loadTruth, series } from "../src/ui/Truth.ts"
import { SOURCE, fakeServer, structured, text } from "./fake-server.ts"

const UI_TASKS = join(import.meta.dirname, "../tasks/ui.json")

describe("UI task generation", () => {
  it.effect("the checked-in task file is exactly what the checked-in truth generates", () =>
    Effect.gen(function* () {
      const onDisk = yield* loadTaskFile(UI_TASKS)
      const generated = yield* generateUi(yield* loadTruth())
      assert.deepStrictEqual(onDisk, generated, "eval/tasks/ui.json is stale: run `bun run eval -- tasks`")
    })
  )

  it.effect(
    "the truth file holds exactly the current captures, so an edited scene is caught without a browser",
    () =>
      Effect.gen(function* () {
        const recorded = (yield* loadTruth()).captures.map((c) => c.key).sort()
        const wanted = [...new Set(UI_CASES.map((k) => captureKey(k.capture)))].sort()
        assert.deepStrictEqual(
          recorded,
          wanted,
          "eval/ui/truth.json is stale: run `bun run eval -- ui-capture`"
        )
      })
  )

  it.effect("covers every UI family in both splits, with unique ids and opaque sources", () =>
    Effect.gen(function* () {
      const tasks = yield* loadTaskFile(UI_TASKS)
      assert.strictEqual(new Set(tasks.map((t) => t.id)).size, tasks.length)
      const families = [...new Set(tasks.map((t) => t.givens._tag))].sort()
      assert.deepStrictEqual(families, [
        "ui-compare",
        "ui-easing",
        "ui-flash",
        "ui-overshoot",
        "ui-repeat",
        "ui-reverse",
        "ui-safe-area",
        "ui-screen-change",
        "ui-settle",
        "ui-skip",
        "ui-start"
      ])
      assert.sameMembers([...new Set(tasks.map((t) => t.split))], ["dev", "heldout"])
      for (const t of tasks) {
        assert.match(t.source, /^ui:[0-9a-f]{16}$/, t.id)
        // The question, without the answer-format line and its examples.
        const question = t.prompt.split("\n\n")[0]!
        assert.notInclude(question, "dur=", t.id)
        if (t.answer._tag === "frame") assert.notInclude(question, `#${t.answer.index}`, t.id)
      }
    })
  )
})

describe("measuring browser truth", () => {
  const frame = { width: 100, height: 100 }
  const at = (y: number, opacity = 1): State => ({ x: 10, y, w: 20, h: 20, opacity })

  it("starts at the first visible change and settles where it stops changing visibly", () => {
    const states = [at(50), at(50), at(49.8), at(49), at(45), at(41), at(40.4), at(40), at(40)]
    assert.deepStrictEqual(startOf(states, frame), { index: 3, tolerance: 1 })
    assert.deepStrictEqual(settleOf(states, frame), { index: 6, tolerance: 2 })
  })

  it("weighs a fade like movement and ignores what is off screen", () => {
    const fade = [at(50, 0), at(50, 0), at(50, 0.01), at(50, 0.05), at(50, 1), at(50, 1)]
    assert.strictEqual(startOf(fade, frame)?.index, 3)
    const offscreen = (x: number): State => ({ x, y: 10, w: 20, h: 20, opacity: 1 })
    const entering = [offscreen(130), offscreen(115), offscreen(99.5), offscreen(90), offscreen(90)]
    // Half a pixel on screen is not yet a visible change; ten pixels are.
    assert.strictEqual(startOf(entering, frame)?.index, 3)
    assert.deepStrictEqual(boxOf(entering[2]!, frame), { x: 99, y: 10, w: 1, h: 20 })
    assert.isUndefined(settleOf([at(50), at(40)], frame))
    // A measured track that jitters at rest settles once jitter is allowed for.
    const jitter = [at(50), at(40), at(40.06), at(40), at(40.06)]
    assert.isUndefined(settleOf(jitter, frame))
    assert.strictEqual(settleOf(jitter, frame, 0.5)?.index, 1)
  })

  it("counts reversals, ignoring jitter inside the hysteresis", () => {
    const spring = [0, 0.01, 0, 60, 120, 110, 98, 101, 100.2, 100.21, 100.2]
    assert.deepStrictEqual(turningPoints(spring), [1, 2, 4, 6, 7, 8, 9])
    assert.deepStrictEqual(turningPoints(spring, 0.5), [4, 6, 7])
  })

  it("finds repeated and doubled steps only while moving", () => {
    const x = [0, 0, 8, 16, 16, 24, 40, 48, 48, 48]
    assert.deepStrictEqual(stutters(x), { repeats: [4], skips: [6] })
  })
})

const SyntheticSources = Sources.layerFrom(SyntheticAdapter).pipe(Layer.provide(SyntheticAdapter.layer))

/** A probe result with the capture's clock and frame size. */
const probeOf = (truth: CaptureTruth) =>
  Effect.gen(function* () {
    const spec = `synthetic:bounce?size=${truth.width}x${truth.height}&fps=${truth.fps}&frames=${truth.frames}`
    return (yield* (yield* Sources).open(spec, "probe")).timeline
  }).pipe(Effect.scoped, Effect.provide(SyntheticSources))

/** What a perfect tracker would return for the element whose box at 0f is `box`. */
const perfectTrack = (truth: CaptureTruth, box: string) => {
  const elements = [...new Set(Object.keys(truth.tracks).map((n) => n.split(".")[0]!))]
  const element = elements.find((e) => {
    const b = boxOf(
      {
        x: series(truth, `${e}.x`)![0]!,
        y: series(truth, `${e}.y`)![0]!,
        w: series(truth, `${e}.w`)![0]!,
        h: series(truth, `${e}.h`)![0]!,
        opacity: 1
      },
      truth
    )
    return b !== undefined && `${b.x},${b.y},${b.w},${b.h}` === box
  })
  if (element === undefined) throw new Error(`no element at ${box}`)
  return structured.track({
    handle: "s",
    range: "0f..-1f",
    method: "template",
    tracks: ["x", "y", "w", "h"].map((p) => ({
      name: `box.${p}`,
      unit: "px",
      min: null,
      max: null,
      keyframes: [],
      samples: series(truth, `${element}.${p}`)!.map((value, i) => ({
        address: `#${i}`,
        index: frameIndex(i),
        t: i / truth.fps,
        value
      }))
    })),
    plot: null,
    easing: [],
    lost: []
  })
}

describe("oracle UI strategies", () => {
  const TRACKED = ["ui-easing", "ui-overshoot", "ui-reverse", "ui-compare"]

  it.effect("answer every tracking task correctly when the tracker is perfect", () =>
    Effect.gen(function* () {
      const truth = yield* loadTruth()
      const tasks = (yield* loadTaskFile(UI_TASKS)).filter(
        (t) =>
          TRACKED.includes(t.givens._tag) ||
          ((t.givens._tag === "ui-start" || t.givens._tag === "ui-settle") &&
            t.givens.subject.seen === "first-frame")
      )
      assert.isAtLeast(tasks.length, 20)
      for (const task of tasks) {
        const capture = truth.captures.find((c) => `ui:${c.key}` === task.source)!
        const timeline = yield* probeOf(capture)
        const tools = yield* fakeServer([
          {
            name: "kymo_probe",
            properties: SOURCE,
            handle: () => ({ content: [text("probe")], structuredContent: structured.probe(timeline) })
          },
          {
            name: "kymo_track",
            properties: { ...SOURCE, box: { type: "string" }, range: { type: "string" } },
            handle: (args) => ({
              content: [text("tracked")],
              structuredContent: perfectTrack(capture, String(args["box"]))
            })
          }
        ])
        const run = yield* runTask({
          task,
          source: "opaque",
          model: oracle,
          tools,
          options: { system: "", maxCalls: 5 }
        })
        assert.isTrue(run.pass, `${task.id}: ${run.steps[0]?.reply}`)
      }
    }).pipe(Effect.scoped)
  )
})
