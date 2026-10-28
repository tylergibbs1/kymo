import { assert, describe, it } from "@effect/vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Sources } from "@kymo/sources"
import { Effect } from "effect"
import { DEV_SHARE, splitOf } from "../src/Split.ts"
import { CASES, buildTask, classifyEasing, generate } from "../src/Synthetic.ts"
import { loadClips, loadTaskFile } from "../src/TaskSet.ts"

const TASK_FILE = join(import.meta.dirname, "../tasks/synthetic.json")

describe("synthetic task generation", () => {
  it.effect("the checked-in task file is exactly what ground truth generates", () =>
    Effect.gen(function* () {
      const onDisk = yield* loadTaskFile(TASK_FILE)
      const generated = yield* generate()
      assert.deepStrictEqual(
        onDisk,
        generated,
        "eval/tasks/synthetic.json is stale: run `bun run eval -- tasks`"
      )
    })
  )

  it.effect("covers every question type, about 40 tasks, unique ids", () =>
    Effect.gen(function* () {
      const tasks = yield* loadTaskFile(TASK_FILE)
      assert.isAtLeast(tasks.length, 36)
      assert.strictEqual(new Set(tasks.map((t) => t.id)).size, tasks.length)
      assert.sameMembers(
        [...new Set(tasks.map((t) => t.givens._tag))],
        ["impact", "bounces", "easing", "flicker", "safe-area", "cut", "dropped"]
      )
    })
  )

  it.effect("answers follow the scene parameters through the source's truth markers", () =>
    Effect.gen(function* () {
      const impact = yield* buildTask({
        id: "t-impact",
        family: "impact",
        scene: "bounce",
        params: { impact: 33 }
      })
      assert.deepStrictEqual(impact.answer, { _tag: "frame", index: 33, tolerance: 1 })
      const bounces = yield* buildTask({
        id: "t-bounces",
        family: "bounces",
        scene: "bounce",
        params: { frames: 120, impact: 20, bounces: 4, period: 20 }
      })
      assert.deepStrictEqual(bounces.answer, { _tag: "count", value: 4 })
      const dropped = yield* buildTask({
        id: "t-dropped",
        family: "dropped",
        scene: "dropped",
        params: { dups: "9,3" }
      })
      assert.deepStrictEqual(dropped.answer, { _tag: "frames", indices: [3, 9], tolerance: 0 })
      assert.strictEqual(dropped.clock.frames, 90)
    })
  )

  it.effect("an easing case whose curve disagrees with its expected label fails generation", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        buildTask({
          id: "t-ease",
          family: "easing",
          scene: "ease",
          params: { easing: "ease-out" },
          expect: "ease-in"
        })
      )
      assert.strictEqual(error._tag, "TruthMismatch")
    })
  )

  it("prompts never contain the answer or the scene parameters", () =>
    Effect.runPromise(
      Effect.map(generate(CASES.filter((k) => k.family !== "easing")), (tasks) => {
        for (const t of tasks) {
          assert.notInclude(t.prompt, "synthetic:", t.id)
          if (t.answer._tag === "frame") assert.notInclude(t.prompt, `#${t.answer.index}`, t.id)
        }
      })
    ))
})

describe("classifyEasing", () => {
  const curve = (f: (t: number) => number) => Array.from({ length: 41 }, (_, i) => f(i / 40))
  it("names the presets by their quarter points and springs by overshoot", () => {
    assert.strictEqual(
      classifyEasing(
        curve((t) => t),
        0,
        40
      ),
      "linear"
    )
    assert.strictEqual(
      classifyEasing(
        curve((t) => t * t),
        0,
        40
      ),
      "ease-in"
    )
    assert.strictEqual(
      classifyEasing(
        curve((t) => 1 - (1 - t) ** 2),
        0,
        40
      ),
      "ease-out"
    )
    assert.strictEqual(
      classifyEasing(
        curve((t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2)),
        0,
        40
      ),
      "ease-in-out"
    )
    assert.strictEqual(
      classifyEasing(
        curve((t) => Math.min(1.1, 1.3 * t)),
        0,
        40
      ),
      "spring"
    )
  })
})

describe("split", () => {
  it("is a pure function of the id: stable across calls and independent of other tasks", () => {
    assert.strictEqual(splitOf("impact-30fps-f20"), "dev")
    assert.strictEqual(splitOf("impact-30fps-f30"), "heldout")
    assert.strictEqual(splitOf("flicker-f45-faint"), splitOf("flicker-f45-faint"))
  })
  it("puts about 70% of ids in dev", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `task-${i}`)
    const dev = ids.filter((id) => splitOf(id) === "dev").length / ids.length
    assert.approximately(dev, DEV_SHARE, 0.04)
  })
})

describe("clip manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "kymo-clips-"))
  const write = (name: string, body: unknown) => {
    const path = join(dir, name)
    writeFileSync(path, JSON.stringify(body))
    return path
  }
  const entry = {
    id: "modal-open",
    category: "ui-animation",
    file: "modal-open.mp4",
    origin: { url: "https://example.com/modal-open.mp4", license: "CC-BY-4.0" },
    prompt: "When does the modal finish opening?",
    answer: { _tag: "frame", index: 12, tolerance: 1 }
  }

  it.effect("lists entries whose files are not on disk instead of failing", () =>
    Effect.gen(function* () {
      const loaded = yield* loadClips(write("clips.json", { clips: [entry] }))
      assert.deepStrictEqual(loaded, { tasks: [], missing: ["modal-open"] })
    }).pipe(Effect.provide(Sources.layer))
  )

  it.effect("rejects a malformed manifest with the file path", () =>
    Effect.gen(function* () {
      const path = write("bad.json", {
        clips: [{ ...entry, answer: { _tag: "frame", index: -1, tolerance: 0 } }]
      })
      const error = yield* Effect.flip(loadClips(path))
      assert.strictEqual(error._tag, "TaskFileInvalid")
      assert.include(JSON.stringify(error), "bad.json")
    }).pipe(Effect.provide(Sources.layer))
  )
})
