/**
 * Runs an experiment: for each variant, start a server with the variant's config, pin its tool
 * arguments, and run every task through the loop. Results stream to `runs.jsonl` as tasks finish, so
 * an interrupted run keeps what it measured; `results.json` and `summary.md` are written at the end.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { KymoError } from "@kymo/core"
import { Effect, type Scope } from "effect"
import type { Experiment, Variant } from "./Experiments.ts"
import { type TaskRun, runTask } from "./Loop.ts"
import type { ModelBackend } from "./Model.ts"
import { type PinMismatch, pin } from "./Pin.ts"
import { present } from "./Present.ts"
import { type VariantRun, markdown, rows } from "./Report.ts"
import type { Task } from "./Task.ts"
import type { ToolBackend, ToolTransportError } from "./Tools.ts"

export interface RunConfig {
  readonly experiment: Experiment
  readonly model: ModelBackend
  readonly tasks: ReadonlyArray<Task>
  readonly system: string
  readonly maxCalls: number
  readonly concurrency: number
  /** Where synthetic renderings are cached between runs. */
  readonly cacheDir: string
  /** This run's report directory, e.g. eval/reports/runs/2026-10-28T14-00-00Z. */
  readonly outDir: string
  readonly startedAt: string
  /** Start a tool server for a variant. The server lives as long as the Scope. */
  readonly connect: (variant: Variant) => Effect.Effect<ToolBackend, ToolTransportError, Scope.Scope>
  readonly progress: (line: string) => void
}

export interface RunResult {
  readonly variants: ReadonlyArray<VariantRun>
  readonly summaryPath: string
  readonly resultsPath: string
}

const runVariant = (config: RunConfig, variant: Variant, log: string) =>
  Effect.gen(function* () {
    const sources = yield* Effect.forEach(config.tasks, (task) => present(task, config.cacheDir))
    const tools = yield* pin(yield* config.connect(variant), variant.pin)
    let done = 0
    const runs = yield* Effect.forEach(
      config.tasks,
      (task, i) =>
        Effect.tap(
          runTask({
            task,
            source: sources[i]!,
            model: config.model,
            tools,
            options: { system: config.system, maxCalls: config.maxCalls }
          }),
          (run: TaskRun) =>
            Effect.sync(() => {
              done++
              appendFileSync(log, `${JSON.stringify({ variant: variant.name, ...run })}\n`)
              config.progress(
                `[${variant.name} ${done}/${config.tasks.length}] ${run.taskId}: ${run.pass ? "pass" : "fail"} (${run.stop}, ${run.metrics.toolCalls} calls)`
              )
            })
        ),
      { concurrency: config.concurrency }
    )
    return { variant: variant.name, runs } satisfies VariantRun
  }).pipe(Effect.scoped)

export const runExperiment = (
  config: RunConfig
): Effect.Effect<RunResult, PinMismatch | ToolTransportError | KymoError> =>
  Effect.gen(function* () {
    mkdirSync(config.outDir, { recursive: true })
    const log = join(config.outDir, "runs.jsonl")
    const variants = yield* Effect.forEach(config.experiment.variants, (v) => runVariant(config, v, log))
    const header = {
      experiment: config.experiment.name,
      question: config.experiment.question,
      model: config.model.id,
      startedAt: config.startedAt,
      maxCalls: config.maxCalls
    }
    const resultsPath = join(config.outDir, "results.json")
    const summaryPath = join(config.outDir, "summary.md")
    writeFileSync(
      resultsPath,
      `${JSON.stringify({ ...header, variants: config.experiment.variants, summary: rows(variants), runs: variants }, null, 2)}\n`
    )
    writeFileSync(summaryPath, markdown(header, variants))
    return { variants, summaryPath, resultsPath }
  })
