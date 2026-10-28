/**
 * Deterministic scoring. A reply is read for its last `ANSWER:` line; frame answers are parsed with
 * kymo's own address grammar and resolved against the task's clock, so `08s10f`, `#250` and `8.33s`
 * all mean what kymo means by them.
 */
import { Address } from "@kymo/core"
import { Result } from "effect"
import type { Answer, Clock } from "./Task.ts"

export interface Score {
  readonly pass: boolean
  /** The text after `ANSWER:`, or null when the reply has no answer line. */
  readonly given: string | null
  /** |predicted − true| in frames for frame answers (mean over pairs for frame lists); null otherwise or unparsable. */
  readonly frameError: number | null
  /** Why the answer could not be read, when it could not. */
  readonly problem: string | null
}

const ANSWER_LINE = /^[\s>*_-]*ANSWER\s*:\s*(.+?)\s*$/gim

/** The last `ANSWER:` value in a reply, with wrapping quotes, backticks and a trailing period removed. */
export const extractAnswer = (reply: string): string | undefined => {
  const all = [...reply.matchAll(ANSWER_LINE)]
  const last = all[all.length - 1]?.[1]
  // No address ends in ".", so a trailing period is punctuation; a leading one may be `.5s`.
  return last?.replace(/^[\s`"'*_]+/, "").replace(/[\s`"'*_.]+$/, "")
}

/** Markers are deliberately absent: a reply naming a truth marker (`@cut`) does not score. */
const contextOf = (clock: Clock): Address.ResolveContext => ({
  handle: "answer",
  kind: "answer",
  rate: clock.rate,
  first: 0,
  count: clock.frames,
  live: false,
  markers: []
})

/** Resolve one address to the single frame it names. Ranges are not single frames. */
export const resolveFrame = (clock: Clock, text: string): Result.Result<number, string> => {
  const parsed = Address.parse(text)
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure.message)
  if (parsed.success.spec._tag === "Range") return Result.fail(`${text} is a range, not one frame`)
  return Result.match(Address.resolve(contextOf(clock), parsed.success), {
    onFailure: (e) => Result.fail(e.message),
    onSuccess: (indices) => Result.succeed(indices[0]!)
  })
}

/** Resolve a comma-separated list; ranges expand to every frame they name. */
const resolveFrames = (clock: Clock, text: string): Result.Result<ReadonlyArray<number>, string> => {
  const out: Array<number> = []
  for (const part of text.split(/[,\s]+/).filter((p) => p.length > 0)) {
    const parsed = Address.parse(part)
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure.message)
    const resolved = Address.resolve(contextOf(clock), parsed.success)
    if (Result.isFailure(resolved)) return Result.fail(resolved.failure.message)
    out.push(...resolved.success)
  }
  return out.length > 0
    ? Result.succeed([...new Set(out)].sort((a, b) => a - b))
    : Result.fail("no frames listed")
}

const unreadable = (given: string | null, problem: string): Score => ({
  pass: false,
  given,
  frameError: null,
  problem
})

/** Score a model's full reply against a task's answer. */
export const score = (answer: Answer, clock: Clock, reply: string): Score => {
  const given = extractAnswer(reply)
  if (given === undefined || given.length === 0) return unreadable(null, "no ANSWER: line")
  switch (answer._tag) {
    case "frame":
      return Result.match(resolveFrame(clock, given), {
        onFailure: (problem) => unreadable(given, problem),
        onSuccess: (index) => {
          const frameError = Math.abs(index - answer.index)
          return { pass: frameError <= answer.tolerance, given, frameError, problem: null }
        }
      })
    case "frames":
      return Result.match(resolveFrames(clock, given), {
        onFailure: (problem) => unreadable(given, problem),
        onSuccess: (indices) => {
          const truth = [...answer.indices].sort((a, b) => a - b)
          if (indices.length !== truth.length) {
            return {
              pass: false,
              given,
              frameError: null,
              problem: `listed ${indices.length} frames, expected ${truth.length}`
            }
          }
          const errors = indices.map((i, k) => Math.abs(i - truth[k]!))
          return {
            pass: errors.every((e) => e <= answer.tolerance),
            given,
            frameError: errors.reduce((a, b) => a + b, 0) / errors.length,
            problem: null
          }
        }
      })
    case "label": {
      const normalized = given.toLowerCase().replace(/[\s_]+/g, "-")
      return { pass: normalized === answer.value, given, frameError: null, problem: null }
    }
    case "count": {
      if (!/^\d+$/.test(given)) return unreadable(given, `${given} is not a whole number`)
      return { pass: Number(given) === answer.value, given, frameError: null, problem: null }
    }
  }
}
