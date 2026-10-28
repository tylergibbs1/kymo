/**
 * kymo eval CLI.
 *
 *   npx tsx eval/src/main.ts run --model oracle --split dev --experiment target --limit 10 [--set ui]
 *   npx tsx eval/src/main.ts tasks          regenerate eval/tasks/{synthetic,ui}.json from ground truth
 *   npx tsx eval/src/main.ts ui-capture     capture the UI scenes in Chromium, record their truth,
 *                                           and regenerate eval/tasks/ui.json from it
 *   npx tsx eval/src/main.ts experiments    list experiments and their variants
 *   npx tsx eval/src/main.ts export --out DIR --key DIR [--split dev|heldout|all] [--set S]
 *                                           questions for an outside agent; the key goes elsewhere
 *   npx tsx eval/src/main.ts score --key DIR/key.json --answers answers.json [--set S]
 *
 * Reports go to eval/reports/runs/<timestamp>/; progress goes to stderr.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { Sources } from "@kymo/sources"
import { Effect, Schema } from "effect"
import { toEnv } from "kymo"
import { EXPERIMENTS, experimentNamed } from "./Experiments.ts"
import { Answers, exportQuestions, scoreAnswers, summarize } from "./External.ts"
import { modelFor } from "./Models.ts"
import { uiFootage } from "./Present.ts"
import { systemPrompt } from "./Prompts.ts"
import { runExperiment } from "./Runner.ts"
import { generate } from "./Synthetic.ts"
import { loadClips, loadTaskFile, writeTaskFile } from "./TaskSet.ts"
import type { Task } from "./Task.ts"
import { spawn } from "./Tools.ts"
import { UI_CASES } from "./ui/Cases.ts"
import { generateUi } from "./ui/Tasks.ts"
import { loadTruth, writeTruth } from "./ui/Truth.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const PATHS = {
  synthetic: join(ROOT, "eval/tasks/synthetic.json"),
  ui: join(ROOT, "eval/tasks/ui.json"),
  clips: join(ROOT, "eval/tasks/clips.json"),
  skill: join(ROOT, "skills/kymo/SKILL.md"),
  cache: join(ROOT, "eval/.cache"),
  runs: join(ROOT, "eval/reports/runs")
}
const DEFAULT_SERVER = "npx tsx apps/cli/src/bin.ts mcp"

const err = (line: string) => process.stderr.write(`${line}\n`)

const NumberArg = (min: number) =>
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(min))

/** Which checked-in task files a command reads. */
const TaskSetArg = Schema.Literals(["synthetic", "ui", "all"])
type TaskSetArg = typeof TaskSetArg.Type

const RunArgs = Schema.Struct({
  set: TaskSetArg,
  model: Schema.String,
  experiment: Schema.String,
  split: Schema.Literals(["dev", "heldout", "all"]),
  limit: Schema.optionalKey(NumberArg(1)),
  family: Schema.optionalKey(Schema.String),
  "per-family": Schema.optionalKey(NumberArg(1)),
  "max-calls": NumberArg(1),
  concurrency: NumberArg(1),
  server: Schema.String,
  "server-log": Schema.Boolean,
  clips: Schema.Boolean,
  effort: Schema.Literals(["low", "medium", "high", "xhigh", "max"]),
  "max-tokens": NumberArg(1024)
})

const USAGE = `Usage:
  main.ts run [--model oracle|claude-opus-5-5|claude-sonnet-5-5|...] [--experiment baseline|${EXPERIMENTS.map(
    (e) => e.name
  )
    .filter((n) => n !== "baseline")
    .join("|")}]
              [--set synthetic|ui|all] [--split dev|heldout|all] [--limit N] [--family F]
              [--per-family N] [--max-calls N]
              [--concurrency N] [--server "${DEFAULT_SERVER}"] [--server-log] [--clips]
              [--effort low|medium|high|xhigh|max] [--max-tokens N]
  main.ts tasks
  main.ts ui-capture
  main.ts experiments
  main.ts export --out DIR --key DIR [--split dev|heldout|all] [--set synthetic|ui|all]
  main.ts score --key KEY.json --answers ANSWERS.json [--title TEXT] [--set synthetic|ui|all]`

/**
 * The tasks of a set. UI tasks whose footage is not in the cache are left out and listed, like clips
 * not on disk: footage is captured locally (ui-capture), never committed.
 */
const loadSet = (set: TaskSetArg) =>
  Effect.gen(function* () {
    const synthetic = set === "ui" ? [] : yield* loadTaskFile(PATHS.synthetic)
    const ui = set === "synthetic" ? [] : yield* loadTaskFile(PATHS.ui)
    const missing = ui.filter((t) => !existsSync(uiFootage(t, PATHS.cache) ?? ""))
    if (missing.length > 0)
      err(
        `Skipping ${missing.length} UI tasks whose footage is not cached (${missing
          .slice(0, 3)
          .map((t) => t.id)
          .join(", ")}${missing.length > 3 ? ", …" : ""}). Run \`npm run eval -- ui-capture\` first.`
      )
    return [...synthetic, ...ui.filter((t) => !missing.includes(t))]
  })

/** Filter, then cap: --family, --per-family and --limit compose in that order. */
const select = (tasks: ReadonlyArray<Task>, args: typeof RunArgs.Type): ReadonlyArray<Task> => {
  let out = tasks.filter((t) => args.split === "all" || t.split === args.split)
  if (args.family !== undefined) out = out.filter((t) => t.givens._tag === args.family)
  const perFamily = args["per-family"]
  if (perFamily !== undefined) {
    const seen = new Map<string, number>()
    out = out.filter((t) => {
      const n = seen.get(t.givens._tag) ?? 0
      seen.set(t.givens._tag, n + 1)
      return n < perFamily
    })
  }
  return args.limit === undefined ? out : out.slice(0, args.limit)
}

const serverHint = (e: { readonly message: string }) =>
  new Error(
    `${e.message}\nCheck --server (default "${DEFAULT_SERVER}"), or rerun with --server-log to see its stderr.`
  )

const run = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        set: { type: "string", default: "synthetic" },
        model: { type: "string", default: "oracle" },
        experiment: { type: "string", default: "baseline" },
        split: { type: "string", default: "dev" },
        limit: { type: "string" },
        family: { type: "string" },
        "per-family": { type: "string" },
        "max-calls": { type: "string", default: "20" },
        concurrency: { type: "string", default: "1" },
        server: { type: "string", default: DEFAULT_SERVER },
        "server-log": { type: "boolean", default: false },
        clips: { type: "boolean", default: false },
        effort: { type: "string", default: "high" },
        "max-tokens": { type: "string", default: "16000" }
      }
    })
    const args = yield* Schema.decodeUnknownEffect(RunArgs)(values)
    const experiment = experimentNamed(args.experiment)
    if (!experiment) return yield* Effect.fail(new Error(`No experiment "${args.experiment}". ${USAGE}`))
    const model = yield* modelFor(args.model, { effort: args.effort, maxTokens: args["max-tokens"] })

    const base = yield* loadSet(args.set)
    const clips = args.clips
      ? yield* Effect.provide(loadClips(PATHS.clips), Sources.layer)
      : { tasks: [], missing: [] }
    if (clips.missing.length > 0) err(`Skipping clips not on disk: ${clips.missing.join(", ")}`)
    const tasks = select([...base, ...clips.tasks], args)
    if (tasks.length === 0) return yield* Effect.fail(new Error("No tasks match the filters."))

    const [command, ...commandArgs] = args.server.split(/\s+/).filter((s) => s.length > 0)
    const startedAt = new Date().toISOString()
    const outDir = join(PATHS.runs, `${startedAt.replace(/[:.]/g, "-")}-${experiment.name}-${model.id}`)
    err(
      `${experiment.name} × ${model.id}: ${tasks.length} tasks, ${experiment.variants.length} variant(s) → ${outDir}`
    )
    const result = yield* runExperiment({
      experiment,
      model,
      tasks,
      system: systemPrompt(readFileSync(PATHS.skill, "utf8")),
      maxCalls: args["max-calls"],
      concurrency: args.concurrency,
      cacheDir: PATHS.cache,
      outDir,
      startedAt,
      connect: (variant) =>
        spawn({
          command: command!,
          args: commandArgs,
          cwd: ROOT,
          env: toEnv(variant.config),
          stderr: args["server-log"] ? "inherit" : "ignore"
        }),
      progress: err
    }).pipe(Effect.catchTag("ToolTransportError", (e) => Effect.fail(serverHint(e))))
    err(readFileSync(result.summaryPath, "utf8"))
    process.stdout.write(`${result.summaryPath}\n`)
  })

const writeTasks = (path: string, generated: ReadonlyArray<Task>) => {
  writeTaskFile(path, generated)
  const dev = generated.filter((t) => t.split === "dev").length
  err(`Wrote ${generated.length} tasks (${dev} dev, ${generated.length - dev} heldout) to ${path}`)
}

/** Regenerate both task files: synthetic from the adapter, UI from the checked-in browser truth. */
const tasks = Effect.gen(function* () {
  writeTasks(PATHS.synthetic, yield* generate())
  writeTasks(PATHS.ui, yield* generateUi(yield* loadTruth()))
})

/** Capture every UI scene (reusing cached footage), write the truth file, then the UI tasks. */
const uiCapture = Effect.gen(function* () {
  // Loaded here so that only this command needs Playwright.
  const { captureAll } = yield* Effect.promise(() => import("./ui/Capture.ts"))
  const specs = [...new Map(UI_CASES.map((k) => [JSON.stringify(k.capture), k.capture])).values()]
  const captures = yield* captureAll(specs, PATHS.cache, err)
  writeTruth({ captures })
  err(`Recorded truth for ${captures.length} captures`)
  writeTasks(PATHS.ui, yield* generateUi(yield* loadTruth()))
})

const experiments = Effect.sync(() => {
  for (const e of EXPERIMENTS) err(`${e.name}: ${e.question}\n  ${e.variants.map((v) => v.name).join(", ")}`)
})

const exportCommand = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        out: { type: "string" },
        key: { type: "string" },
        split: { type: "string", default: "all" },
        set: { type: "string", default: "synthetic" }
      }
    })
    if (values.out === undefined || values.key === undefined) return yield* Effect.fail(new Error(USAGE))
    const split = values.split
    const set = yield* Schema.decodeUnknownEffect(TaskSetArg)(values.set)
    const tasks = (yield* loadSet(set)).filter((t) => split === "all" || t.split === split)
    const n = yield* exportQuestions({
      tasks,
      cacheDir: PATHS.cache,
      questionsDir: resolve(values.out),
      keyDir: resolve(values.key)
    })
    err(
      `Wrote ${n} questions to ${resolve(values.out)}/questions.json; key in ${resolve(values.key)}/key.json`
    )
  })

const scoreCommand = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        key: { type: "string" },
        answers: { type: "string" },
        title: { type: "string", default: "External agent" },
        set: { type: "string", default: "all" }
      }
    })
    if (values.key === undefined || values.answers === undefined) return yield* Effect.fail(new Error(USAGE))
    const answers = yield* Schema.decodeUnknownEffect(Answers)(
      JSON.parse(readFileSync(values.answers, "utf8"))
    )
    const set = yield* Schema.decodeUnknownEffect(TaskSetArg)(values.set)
    const tasks = yield* loadSet(set)
    const results = yield* scoreAnswers({ tasks, keyPath: values.key, answers })
    process.stdout.write(summarize(results, values.title))
  })

const [command, ...rest] = process.argv.slice(2)
const program =
  command === "run"
    ? run(rest)
    : command === "tasks"
      ? tasks
      : command === "ui-capture"
        ? uiCapture
        : command === "experiments"
          ? experiments
          : command === "export"
            ? exportCommand(rest)
            : command === "score"
              ? scoreCommand(rest)
              : Effect.fail(new Error(USAGE))

Effect.runPromise(program).catch((e: unknown) => {
  err(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
