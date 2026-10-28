import { assert, describe, it } from "@effect/vitest"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { exportQuestions, scoreAnswers, summarize } from "../src/External.ts"
import { loadTaskFile } from "../src/TaskSet.ts"

const TASKS = join(import.meta.dirname, "../tasks/synthetic.json")
const CACHE = join(import.meta.dirname, "../.cache/frames")

describe("external agents", () => {
  it.effect("export hides the answer and scoring reads replies like the loop does", () =>
    Effect.gen(function* () {
      const all = yield* loadTaskFile(TASKS)
      const tasks = [all.find((t) => t.givens._tag === "flicker")!, all.find((t) => t.givens._tag === "cut")!]
      const root = mkdtempSync(join(tmpdir(), "kymo-external-"))
      const out = join(root, "questions")
      const keyDir = join(root, "key")
      yield* exportQuestions({ tasks, cacheDir: CACHE, questionsDir: out, keyDir })

      const exported = readFileSync(join(out, "questions.json"), "utf8")
      for (const task of tasks) {
        assert.notInclude(exported, task.id)
        assert.notInclude(exported, task.source)
      }
      assert.notInclude(exported, "synthetic:")
      assert.deepStrictEqual(readdirSync(out).sort(), ["clips", "questions.json"])

      const [flicker, cut] = tasks as [(typeof tasks)[number], (typeof tasks)[number]]
      const right = flicker.answer._tag === "frame" ? `#${flicker.answer.index}` : "?"
      const answers = { q01: `It flashes there.\nANSWER: ${right}` }
      writeFileSync(join(root, "answers.json"), JSON.stringify(answers))
      const results = yield* scoreAnswers({ tasks, keyPath: join(keyDir, "key.json"), answers })
      assert.deepStrictEqual(
        results.map((r) => [r.taskId, r.score.pass, r.score.problem]),
        [
          [flicker.id, true, null],
          [cut.id, false, "no reply"]
        ]
      )
      assert.include(summarize(results, "t"), "Overall 1/2")
    })
  )
})
