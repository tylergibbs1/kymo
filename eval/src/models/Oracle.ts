/**
 * The scripted oracle: a deterministic agent that follows the skill loop (probe, then check, scan or
 * track) and answers from `structuredContent` alone. It never sees the answer and never reads pixels,
 * so a task it fails is a task the tools do not make solvable — that is the baseline every model run is
 * compared against, and the end-to-end check that the server's results carry what an agent needs.
 */
import { ProbeOutput, ScanOutput, TrackOutput } from "kymo"
import { Effect, Result, Schema } from "effect"
import type { Conversation, ModelBackend, Session, Turn } from "../Model.ts"
import { EasingLabel, type Box, isUiGivens } from "../Task.ts"
import type { ToolOutcome, ToolSpec } from "../Tools.ts"
import {
  type Plan,
  type Request,
  easingFromTrack,
  findingsOf,
  fitArgs,
  framesOf,
  outputs,
  resolveOn,
  trackEnding
} from "./OracleKit.ts"
import { uiPlan } from "./OracleUi.ts"

/** Frames where the subject stops moving right: a wall contact. */
export const contacts = (x: ReadonlyArray<number | null>, eps = 0.5): Array<number> => {
  const out: Array<number> = []
  for (let i = 1; i < x.length - 1; i++) {
    const [a, b, c] = [x[i - 1], x[i], x[i + 1]]
    if (a == null || b == null || c == null) continue
    if (b - a > eps && c - b <= eps) out.push(i)
  }
  return out
}

const planFor = (session: Session, tools: ReadonlyArray<ToolSpec>): Plan => {
  const { source, clock } = session
  const { givens } = session
  const spec = (name: string) => tools.find((t) => t.name === name)
  const req = (tool: string, wanted: Record<string, unknown>): Request => ({
    tool,
    args: fitArgs(spec(tool), { source, ...wanted })
  })
  if (isUiGivens(givens)) return uiPlan(givens, { req, clock })
  const probe = req("kymo_probe", {})
  const track = (subject: Box, fit: boolean) =>
    req("kymo_track", {
      box: subject,
      range: "0f..-1f",
      props: ["x", "y", "w", "h"],
      format: "detailed",
      ...(fit ? { fitEasing: true } : {})
    })
  const findings = findingsOf

  switch (givens._tag) {
    case "flicker":
      return {
        requests: [probe, req("kymo_check", { rules: ["flicker"] })],
        conclude: (o) => {
          const f = findings(o, "flicker")[0]
          return f ? Result.succeed(`#${f.index}`) : Result.fail("check reported no flicker")
        }
      }
    case "dropped":
      return {
        requests: [probe, req("kymo_check", { rules: ["duplicate-frames"] })],
        conclude: (o) => {
          const frames = [
            ...new Set(findings(o, "duplicate-frames").flatMap((f) => framesOf(clock, f)))
          ].sort((a, b) => a - b)
          return frames.length > 0
            ? Result.succeed(frames.map((i) => `#${i}`).join(", "))
            : Result.fail("check reported no repeats")
        }
      }
    case "cut":
      return {
        requests: [probe, req("kymo_scan", { sample: "cuts", budget: 6 })],
        conclude: (o) => {
          const first = outputs(ScanOutput, o)
            .flatMap((r) => r.cuts)
            .flatMap((c) => resolveOn(clock, c.from))
            .sort((a, b) => a - b)[0]
          return first === undefined ? Result.fail("scan reported no cut") : Result.succeed(`#${first + 1}`)
        }
      }
    case "impact":
      return {
        requests: [probe, track(givens.subject, false)],
        conclude: (o) =>
          Result.flatMap(trackEnding(o, ".x"), (x) => {
            const hit = contacts(x)[0]
            return hit === undefined
              ? Result.fail("the x track never stops moving right")
              : Result.succeed(`#${hit}`)
          })
      }
    case "bounces":
      return {
        requests: [probe, track(givens.subject, false)],
        conclude: (o) => Result.map(trackEnding(o, ".x"), (x) => String(contacts(x).length))
      }
    case "easing":
      return {
        requests: [probe, track(givens.subject, true)],
        conclude: (o) => {
          const fit = outputs(TrackOutput, o).flatMap((r) => r.easing)[0]?.best.family
          if (fit !== undefined && Schema.is(EasingLabel)(fit)) return Result.succeed(fit)
          return Result.flatMap(trackEnding(o, ".x"), easingFromTrack)
        }
      }
    case "safe-area":
      return {
        requests: [probe, track(givens.subject, false)],
        conclude: (o) => {
          const size = outputs(ProbeOutput, o)[0]?.size
          if (!size) return Result.fail("probe reported no frame size")
          const m = givens.marginPercent / 100
          return Result.flatMap(trackEnding(o, ".x"), (x) =>
            Result.flatMap(trackEnding(o, ".w"), (w) => {
              const i = x.findIndex(
                (xi, k) =>
                  xi != null && w[k] != null && (xi < m * size.width || xi + w[k]! > (1 - m) * size.width)
              )
              return i < 0 ? Result.fail("the box never leaves the safe area") : Result.succeed(`#${i}`)
            })
          )
        }
      }
    case "clip":
      return {
        requests: [probe],
        conclude: () => Result.fail("the oracle has no strategy for open-ended clips")
      }
  }
}

const NO_USAGE = { inputTokens: 0, outputTokens: 0 }

export const oracle: ModelBackend = {
  id: "oracle",
  start: (session) =>
    Effect.sync((): Conversation => {
      const plan = planFor(session, session.tools)
      const outcomes: Array<ToolOutcome> = []
      let next = 0
      const reply = (text: string): Turn => ({ text, calls: [], usage: NO_USAGE, refused: false })
      return {
        send: (input) =>
          Effect.sync((): Turn => {
            if (input._tag === "results") outcomes.push(...input.results.map((r) => r.outcome))
            else if (next >= plan.requests.length)
              return reply("ANSWER: unknown (no strategy for follow-up questions)")
            const request = plan.requests[next]
            if (request) {
              next++
              if (!session.tools.some((t) => t.name === request.tool)) {
                return reply(`The server has no ${request.tool} tool.\nANSWER: unknown`)
              }
              return {
                text: "",
                calls: [{ id: `oracle-${next}`, name: request.tool, args: request.args }],
                usage: NO_USAGE,
                refused: false
              }
            }
            return Result.match(plan.conclude(outcomes), {
              onSuccess: (value) => reply(`Read from structuredContent.\nANSWER: ${value}`),
              onFailure: (why) => reply(`${why}.\nANSWER: unknown`)
            })
          })
      }
    })
}
