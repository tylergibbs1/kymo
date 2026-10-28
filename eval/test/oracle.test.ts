import { assert, describe, it } from "@effect/vitest"
import { join } from "node:path"
import { type Track, frameIndex } from "@kymo/core"
import { Sources, SyntheticAdapter } from "@kymo/sources"
import { Effect, Layer } from "effect"
import { runTask } from "../src/Loop.ts"
import { oracle } from "../src/models/Oracle.ts"
import { loadTaskFile } from "../src/TaskSet.ts"
import { SOURCE, fakeServer, structured, text } from "./fake-server.ts"

const SyntheticSources = Sources.layerFrom(SyntheticAdapter).pipe(Layer.provide(SyntheticAdapter.layer))
const TRACKING = ["impact", "bounces", "easing", "safe-area"]

/** What a tracker would return if it were perfect: the scene's own `box.*` tracks, as a region track. */
const truthTracks = (spec: string) =>
  Effect.gen(function* () {
    const source = yield* (yield* Sources).open(spec, "truth")
    const [x, y, w, h] = yield* Effect.forEach(["box.x", "box.y", "box.w", "box.h"], (n) => source.track(n))
    return { timeline: source.timeline, x: x!, y: y!, w: w!, h: h! }
  }).pipe(Effect.scoped, Effect.provide(SyntheticSources))

describe("oracle tracking strategies", () => {
  it.effect("answer every tracking task correctly from exact tracks", () =>
    Effect.gen(function* () {
      const tasks = (yield* loadTaskFile(join(import.meta.dirname, "../tasks/synthetic.json"))).filter((t) =>
        TRACKING.includes(t.givens._tag)
      )
      assert.isAtLeast(tasks.length, 20)
      for (const task of tasks) {
        const truth = yield* truthTracks(task.source)
        const series = (track: Track) => ({
          name: track.name,
          unit: track.unit,
          min: null,
          max: null,
          keyframes: [],
          samples: track.samples.map((value, i) => ({
            address: `#${i}`,
            index: frameIndex(i),
            t: i / 30,
            value
          }))
        })
        const tools = yield* fakeServer([
          {
            name: "kymo_probe",
            properties: SOURCE,
            handle: () => ({ content: [text("probe")], structuredContent: structured.probe(truth.timeline) })
          },
          {
            name: "kymo_track",
            properties: { ...SOURCE, box: { type: "string" }, range: { type: "string" } },
            handle: () => ({
              content: [text("tracked")],
              structuredContent: structured.track({
                handle: "s",
                range: "0f..-1f",
                method: "template",
                tracks: [truth.x, truth.y, truth.w, truth.h].map(series),
                plot: null,
                easing: []
              })
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
