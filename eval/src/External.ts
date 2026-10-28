/**
 * Evaluate an agent that runs outside this harness (a coding agent with the kymo CLI, another
 * framework). `exportQuestions` writes questions with opaque ids and opaque clip paths to one
 * directory and the answer key to another; the agent sees only the first. `scoreAnswers` reads the
 * agent's replies back and scores them exactly as the in-process loop does.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"
import { Effect, Schema } from "effect"
import { present } from "./Present.ts"
import { type Score, score } from "./Score.ts"
import type { Task } from "./Task.ts"

export const Question = Schema.Struct({ id: Schema.String, source: Schema.String, prompt: Schema.String })
export type Question = typeof Question.Type

const KeyEntry = Schema.Struct({ id: Schema.String, taskId: Schema.String })
const Key = Schema.Struct({ entries: Schema.Array(KeyEntry) })

/** Replies by question id: the agent's full final text, ending with an `ANSWER:` line. */
export const Answers = Schema.Record(Schema.String, Schema.String)

const qid = (n: number) => `q${String(n + 1).padStart(2, "0")}`

/**
 * Write `questions.json` and one clip per question under `questionsDir`, and `key.json` under
 * `keyDir`. Clip paths are `clips/<qid>` (plus `.mp4` for footage), so nothing in a path hints at the
 * answer.
 */
export const exportQuestions = (options: {
  readonly tasks: ReadonlyArray<Task>
  readonly cacheDir: string
  readonly questionsDir: string
  readonly keyDir: string
}) =>
  Effect.gen(function* () {
    mkdirSync(join(options.questionsDir, "clips"), { recursive: true })
    mkdirSync(options.keyDir, { recursive: true })
    const questions: Array<Question> = []
    const entries: Array<typeof KeyEntry.Type> = []
    for (const [n, task] of options.tasks.entries()) {
      const id = qid(n)
      const presented = yield* present(task, options.cacheDir)
      const [path, query] = presented.split("?") as [string, string | undefined]
      // A directory of frames links as clips/q01; a video keeps its extension so it opens as one.
      const clip = join(options.questionsDir, "clips", `${id}${extname(path)}`)
      symlinkSync(path, clip)
      questions.push({ id, source: query ? `${clip}?${query}` : clip, prompt: task.prompt })
      entries.push({ id, taskId: task.id })
    }
    writeFileSync(join(options.questionsDir, "questions.json"), JSON.stringify({ questions }, null, 2))
    writeFileSync(join(options.keyDir, "key.json"), JSON.stringify({ entries }, null, 2))
    return questions.length
  })

export interface ExternalResult {
  readonly id: string
  readonly taskId: string
  readonly family: string
  readonly split: string
  readonly score: Score
}

/** Score replies against the key. A question with no reply scores as a miss with that problem. */
export const scoreAnswers = (options: {
  readonly tasks: ReadonlyArray<Task>
  readonly keyPath: string
  readonly answers: typeof Answers.Type
}): Effect.Effect<ReadonlyArray<ExternalResult>, Schema.SchemaError> =>
  Effect.map(Schema.decodeUnknownEffect(Key)(JSON.parse(readFileSync(options.keyPath, "utf8"))), (key) =>
    key.entries.flatMap((entry) => {
      const task = options.tasks.find((t) => t.id === entry.taskId)
      if (!task) return []
      const reply = options.answers[entry.id]
      const s: Score =
        reply === undefined
          ? { pass: false, given: null, frameError: null, problem: "no reply" }
          : score(task.answer, task.clock, reply)
      return [{ id: entry.id, taskId: task.id, family: task.givens._tag, split: task.split, score: s }]
    })
  )

/** A Markdown summary: accuracy overall, by split and by question type, then each miss. */
export const summarize = (results: ReadonlyArray<ExternalResult>, title: string): string => {
  const pct = (rs: ReadonlyArray<ExternalResult>) =>
    rs.length === 0 ? "–" : `${rs.filter((r) => r.score.pass).length}/${rs.length}`
  const errors = results.flatMap((r) => (r.score.frameError === null ? [] : [r.score.frameError]))
  const meanError = errors.length === 0 ? "–" : (errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(2)
  const families = [...new Set(results.map((r) => r.family))].sort()
  const lines = [
    `# ${title}`,
    "",
    `Overall ${pct(results)} · dev ${pct(results.filter((r) => r.split === "dev"))} · heldout ${pct(
      results.filter((r) => r.split === "heldout")
    )} · mean frame error ${meanError}`,
    "",
    `| ${families.join(" | ")} |`,
    `| ${families.map(() => "---:").join(" | ")} |`,
    `| ${families.map((f) => pct(results.filter((r) => r.family === f))).join(" | ")} |`,
    "",
    "## Misses",
    "",
    "| Question | Task | Given | Problem |",
    "| --- | --- | --- | --- |",
    ...results
      .filter((r) => !r.score.pass)
      .map(
        (r) => `| ${r.id} | ${r.taskId} | ${r.score.given ?? "–"} | ${r.score.problem ?? "wrong answer"} |`
      )
  ]
  return lines.join("\n") + "\n"
}
