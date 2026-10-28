/**
 * The agent loop for one task: give the model the source and question, run its tool calls against the
 * backend until it answers or hits the call limit, score every answer, and account for the cost.
 * `runTask` never fails: model and server failures end the run with a `stop` reason, so one bad task
 * can't sink an experiment.
 */
import { Clock, Effect } from "effect"
import { type Metrics, addUsage, emptyMetrics, imageCost } from "./Metrics.ts"
import type { Input, ModelBackend, Turn } from "./Model.ts"
import { type Score, score } from "./Score.ts"
import type { Answer, Family, Split, Task } from "./Task.ts"
import type { JsonObject, ToolBackend, ToolCall, ToolOutcome, ToolTransportError } from "./Tools.ts"

export type Stop = "answered" | "call-limit" | "refused" | "model-error" | "server-error"

export interface StepResult {
  readonly prompt: string
  readonly reply: string
  readonly score: Score
}

export interface CallRecord {
  readonly name: string
  readonly args: JsonObject
  readonly isError: boolean
  readonly images: number
  /** First text block of an error result: the tag/message/hint the model had to act on. */
  readonly error: string | null
}

export interface TaskRun {
  readonly taskId: string
  readonly family: Family
  readonly split: Split
  readonly model: string
  /** The source string the model saw. */
  readonly source: string
  readonly stop: Stop
  readonly error: string | null
  /** Every question answered and every answer within tolerance. */
  readonly pass: boolean
  /** Frame error of the first question, when it has one. */
  readonly frameError: number | null
  readonly steps: ReadonlyArray<StepResult>
  readonly calls: ReadonlyArray<CallRecord>
  readonly metrics: Metrics
}

export interface LoopOptions {
  readonly system: string
  /** Tool calls allowed across the whole task. The call that would exceed it is not made. */
  readonly maxCalls: number
}

export const firstPrompt = (source: string, question: string) =>
  `The clip to analyse is \`${source}\`. Pass it as the \`source\` argument.\n\n${question}`

export const runTask = (input: {
  readonly task: Task
  readonly source: string
  readonly model: ModelBackend
  readonly tools: ToolBackend
  readonly options: LoopOptions
}): Effect.Effect<TaskRun> => {
  const { task, source, model, tools, options } = input
  const prompt = firstPrompt(source, task.prompt)
  const questions: ReadonlyArray<{ readonly prompt: string; readonly answer: Answer }> = [
    { prompt, answer: task.answer },
    ...task.followUps
  ]
  let metrics = emptyMetrics
  const steps: Array<StepResult> = []
  const calls: Array<CallRecord> = []
  const lastErrored = new Map<string, boolean>()

  const callTool = (
    call: ToolCall
  ): Effect.Effect<{ readonly call: ToolCall; readonly outcome: ToolOutcome }, ToolTransportError> =>
    Effect.gen(function* () {
      if (lastErrored.get(call.name) === true) metrics = { ...metrics, retries: metrics.retries + 1 }
      const outcome: ToolOutcome = yield* tools.call(call.name, call.args)
      const cost = yield* imageCost(outcome.blocks)
      lastErrored.set(call.name, outcome.isError)
      metrics = {
        ...metrics,
        toolCalls: metrics.toolCalls + 1,
        toolErrors: metrics.toolErrors + (outcome.isError ? 1 : 0),
        imagesSent: metrics.imagesSent + cost.images,
        visualTokens: metrics.visualTokens + cost.tokens
      }
      const firstText = outcome.blocks.find((b) => b._tag === "text")
      calls.push({
        name: call.name,
        args: call.args,
        isError: outcome.isError,
        images: cost.images,
        error: outcome.isError && firstText?._tag === "text" ? firstText.text : null
      })
      return { call, outcome }
    })

  const converse = Effect.gen(function* () {
    const conversation = yield* model.start({
      system: options.system,
      tools: tools.tools,
      prompt,
      source,
      givens: task.givens,
      clock: task.clock
    })
    for (const question of questions) {
      let next: Input = { _tag: "user", text: question.prompt }
      while (true) {
        const turn: Turn = yield* conversation.send(next)
        metrics = addUsage(metrics, turn.usage)
        if (turn.refused) return "refused" as const
        if (turn.calls.length === 0) {
          steps.push({
            prompt: question.prompt,
            reply: turn.text,
            score: score(question.answer, task.clock, turn.text)
          })
          break
        }
        if (metrics.toolCalls + turn.calls.length > options.maxCalls) return "call-limit" as const
        // Calls in one turn run in order, so `retries` and the error log read the same on every run.
        next = { _tag: "results", results: yield* Effect.forEach(turn.calls, callTool) }
      }
    }
    return "answered" as const
  })

  return Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const outcome = yield* converse.pipe(
      Effect.map((stop) => ({ stop, error: null })),
      Effect.catchTags({
        ModelError: (e) => Effect.succeed({ stop: "model-error" as const, error: e.message }),
        ToolTransportError: (e) => Effect.succeed({ stop: "server-error" as const, error: e.message })
      })
    )
    const ended = yield* Clock.currentTimeMillis
    const answeredAll = steps.length === questions.length
    return {
      taskId: task.id,
      family: task.givens._tag,
      split: task.split,
      model: model.id,
      source,
      stop: outcome.stop,
      error: outcome.error,
      pass: answeredAll && steps.every((s) => s.score.pass),
      frameError: steps[0]?.score.frameError ?? null,
      steps,
      calls,
      metrics: { ...metrics, wallMs: ended - started }
    } satisfies TaskRun
  })
}
