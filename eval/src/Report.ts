/** Aggregation and the Markdown summary. Pure: runs in, rows and text out. */
import type { Stop, TaskRun } from "./Loop.ts"
import type { Split } from "./Task.ts"

export interface VariantRun {
  readonly variant: string
  readonly runs: ReadonlyArray<TaskRun>
}

export interface Row {
  readonly variant: string
  readonly split: Split
  readonly tasks: number
  /** Share of tasks passed, 0..1. */
  readonly accuracy: number
  /** Mean frame error over tasks that gave a readable frame answer; null when none did. */
  readonly meanFrameError: number | null
  /** The rest are means per task. */
  readonly images: number
  readonly visualTokens: number
  readonly totalTokens: number
  readonly calls: number
  readonly toolErrors: number
  readonly retries: number
  readonly seconds: number
  readonly stops: Readonly<Partial<Record<Stop, number>>>
}

const mean = (xs: ReadonlyArray<number>) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

export const summarize = (variant: string, split: Split, runs: ReadonlyArray<TaskRun>): Row => {
  const errors = runs.flatMap((r) => (r.frameError === null ? [] : [r.frameError]))
  const stops: Partial<Record<Stop, number>> = {}
  for (const r of runs) stops[r.stop] = (stops[r.stop] ?? 0) + 1
  return {
    variant,
    split,
    tasks: runs.length,
    accuracy: mean(runs.map((r) => (r.pass ? 1 : 0))),
    meanFrameError: errors.length === 0 ? null : mean(errors),
    images: mean(runs.map((r) => r.metrics.imagesSent)),
    visualTokens: mean(runs.map((r) => r.metrics.visualTokens)),
    totalTokens: mean(runs.map((r) => r.metrics.inputTokens + r.metrics.outputTokens)),
    calls: mean(runs.map((r) => r.metrics.toolCalls)),
    toolErrors: mean(runs.map((r) => r.metrics.toolErrors)),
    retries: mean(runs.map((r) => r.metrics.retries)),
    seconds: mean(runs.map((r) => r.metrics.wallMs / 1000)),
    stops
  }
}

const SPLITS: ReadonlyArray<Split> = ["dev", "heldout"]

/** One row per variant and split that has runs, dev first. */
export const rows = (variants: ReadonlyArray<VariantRun>): Array<Row> =>
  SPLITS.flatMap((split) =>
    variants.flatMap((v) => {
      const runs = v.runs.filter((r) => r.split === split)
      return runs.length === 0 ? [] : [summarize(v.variant, split, runs)]
    })
  )

const fixed = (n: number, digits = 1) => n.toFixed(digits)
const pct = (n: number) => `${(n * 100).toFixed(0)}%`

const table = (header: ReadonlyArray<string>, body: ReadonlyArray<ReadonlyArray<string>>) =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`)
  ].join("\n")

export interface ReportHeader {
  readonly experiment: string
  readonly question: string
  readonly model: string
  readonly startedAt: string
  readonly maxCalls: number
}

export const markdown = (header: ReportHeader, variants: ReadonlyArray<VariantRun>): string => {
  const all = rows(variants)
  const out: Array<string> = [
    `# ${header.experiment}: ${header.model}`,
    "",
    `${header.question} Run started ${header.startedAt}, at most ${header.maxCalls} tool calls per task. Columns after accuracy are means per task.`
  ]
  for (const split of SPLITS) {
    const splitRows = all.filter((r) => r.split === split)
    if (splitRows.length === 0) continue
    out.push(
      "",
      `## ${split === "dev" ? "Dev" : "Held out"}`,
      "",
      table(
        [
          "Variant",
          "Tasks",
          "Accuracy",
          "Mean frame error",
          "Images",
          "Visual tokens",
          "Total tokens",
          "Calls",
          "Tool errors",
          "Retries",
          "Time (s)"
        ],
        splitRows.map((r) => [
          r.variant,
          String(r.tasks),
          pct(r.accuracy),
          r.meanFrameError === null ? "–" : fixed(r.meanFrameError, 2),
          fixed(r.images),
          fixed(r.visualTokens, 0),
          fixed(r.totalTokens, 0),
          fixed(r.calls),
          fixed(r.toolErrors, 2),
          fixed(r.retries, 2),
          fixed(r.seconds)
        ])
      )
    )
  }
  const families = [...new Set(variants.flatMap((v) => v.runs.map((r) => r.family)))].sort()
  if (families.length > 0) {
    out.push(
      "",
      "## Accuracy by question type (all splits)",
      "",
      table(
        ["Variant", ...families],
        variants.map((v) => [
          v.variant,
          ...families.map((f) => {
            const runs = v.runs.filter((r) => r.family === f)
            return runs.length === 0 ? "–" : `${runs.filter((r) => r.pass).length}/${runs.length}`
          })
        ])
      )
    )
  }
  const failed = variants.flatMap((v) =>
    v.runs.filter((r) => !r.pass).map((r) => ({ variant: v.variant, run: r }))
  )
  if (failed.length > 0) {
    out.push(
      "",
      "## Failures",
      "",
      table(
        ["Task", "Variant", "Split", "Stop", "Answer given", "Problem"],
        failed.map(({ variant, run }) => {
          const step = run.steps.find((s) => !s.score.pass) ?? run.steps[0]
          return [
            run.taskId,
            variant,
            run.split,
            run.stop,
            step?.score.given ?? "–",
            (run.error ?? step?.score.problem ?? (step ? "wrong answer" : "no reply"))
              .replace(/\|/g, "\\|")
              .replace(/\n/g, " ")
          ]
        })
      )
    )
  }
  return `${out.join("\n")}\n`
}
