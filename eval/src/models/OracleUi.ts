/**
 * The oracle's strategies for UI footage. Each follows what the skill tells an agent to do for that
 * question and reads only kymo's structured results; when the tools cannot answer, it says why. These
 * misses are the measurement, so no strategy is tuned to the footage.
 */
import { CheckOutput, ProbeOutput, ScanOutput, TrackOutput } from "kymo"
import { Result, Schema } from "effect"
import { type Box, type Clock, EasingLabel, type UiGivens } from "../Task.ts"
import type { ToolOutcome } from "../Tools.ts"
import { type Frame, type State, settleOf, startOf, turningPoints } from "../ui/Measure.ts"
import {
  type Plan,
  type Requester,
  easingFromTrack,
  findingsOf,
  framesOf,
  outputs,
  resolveOn,
  trackEnding
} from "./OracleKit.ts"

/** Sub-pixel tracker jitter: below the 1 px a change needs to be visible, so not motion. */
const JITTER_PX = 0.5

type Series = ReadonlyArray<number | null>

/** Fill unknown samples from the last known one; fails if the first frame is unknown. */
const carried = (v: Series): Result.Result<Array<number>, string> => {
  const out: Array<number> = []
  for (const s of v) {
    const last = out[out.length - 1]
    if (s !== null) out.push(s)
    else if (last === undefined) return Result.fail("the tracker lost the subject at the first frame")
    else out.push(last)
  }
  return Result.succeed(out)
}

/** The tracked box per frame, from one track call's x, y, w and h. */
const trackedStates = (outcome: ToolOutcome | undefined): Result.Result<Array<State>, string> => {
  const one = outcome === undefined ? [] : [outcome]
  return Result.flatMap(trackEnding(one, ".x"), (x) =>
    Result.flatMap(trackEnding(one, ".y"), (y) =>
      Result.flatMap(trackEnding(one, ".w"), (w) =>
        Result.flatMap(trackEnding(one, ".h"), (h) =>
          Result.map(Result.all([carried(x), carried(y), carried(w), carried(h)]), ([xs, ys, ws, hs]) =>
            xs.map((xi, i): State => ({ x: xi, y: ys[i]!, w: ws[i]!, h: hs[i]!, opacity: 1 }))
          )
        )
      )
    )
  )
}

const frameSize = (outcomes: ReadonlyArray<ToolOutcome>): Result.Result<Frame, string> => {
  const size = outputs(ProbeOutput, outcomes)[0]?.size
  return size ? Result.succeed(size) : Result.fail("probe reported no frame size")
}

/** When the box starts or settles, as track's change summary reports it. */
const changeAt = (
  outcomes: ReadonlyArray<ToolOutcome>,
  clock: Clock,
  which: "starts" | "settles"
): Result.Result<string, string> => {
  const change = outputs(TrackOutput, outcomes)[0]?.change
  if (change === undefined) return Result.fail("track reported no change for the box")
  const at = change[which]
  if (at === null)
    return Result.fail(
      which === "starts" ? "nothing in the box visibly changes" : "the box still changes at the last frame"
    )
  return frame(resolveOn(clock, at)[0], `track's ${which} address ${at} does not resolve`)
}

const frame = (i: number | undefined, why: string): Result.Result<string, string> =>
  i === undefined || i < 0 ? Result.fail(why) : Result.succeed(`#${i}`)

const mainAxis = (states: ReadonlyArray<State>): Array<number> => {
  const xs = states.map((s) => s.x)
  const ys = states.map((s) => s.y)
  const range = (v: ReadonlyArray<number>) => Math.max(...v) - Math.min(...v)
  return range(xs) >= range(ys) ? xs : ys
}

export const uiPlan = (givens: UiGivens, ctx: { readonly req: Requester; readonly clock: Clock }): Plan => {
  const { req, clock } = ctx
  const probe = req("kymo_probe", {})
  const track = (box: Box, props: ReadonlyArray<string>, fitEasing = false) =>
    req("kymo_track", {
      box,
      range: "0f..-1f",
      props,
      format: "detailed",
      ...(fitEasing ? { fitEasing: true } : {})
    })
  const xywh = ["x", "y", "w", "h"]
  const check = (rules: ReadonlyArray<string>, extra: Record<string, unknown> = {}) =>
    req("kymo_check", { rules, ...extra })

  switch (givens._tag) {
    case "ui-start":
    case "ui-settle": {
      const first = givens._tag === "ui-start"
      // Visible at 0f: follow it. Entering from nothing: there is no box to follow from 0f, so
      // measure change inside the box where it comes to rest, as the skill's recipe says.
      if (givens.subject.seen === "first-frame")
        return {
          requests: [probe, track(givens.subject.box, xywh)],
          conclude: (o) =>
            Result.flatMap(frameSize(o), (size) =>
              Result.flatMap(trackedStates(o[1]), (states) => {
                const at = first ? startOf(states, size) : settleOf(states, size, JITTER_PX)
                return frame(
                  at?.index,
                  first ? "the tracked box never moves" : "the tracked box never settles"
                )
              })
            )
        }
      return {
        requests: [
          probe,
          req("kymo_track", { box: givens.subject.box, range: "0f..-1f", props: ["change"] })
        ],
        conclude: (o) => changeAt(o, clock, first ? "starts" : "settles")
      }
    }
    case "ui-easing":
      return {
        requests: [probe, track(givens.subject, xywh, true)],
        conclude: (o) => {
          const fit = outputs(TrackOutput, o).flatMap((r) => r.easing)[0]?.best.family
          if (fit !== undefined && Schema.is(EasingLabel)(fit)) return Result.succeed(fit)
          return Result.flatMap(trackedStates(o[1]), (states) => easingFromTrack(mainAxis(states)))
        }
      }
    case "ui-overshoot":
      return {
        requests: [probe, track(givens.subject, xywh)],
        conclude: (o) =>
          Result.map(trackedStates(o[1]), (states) => {
            const v = mainAxis(states)
            const rest = v[v.length - 1]!
            // Half a pixel of hysteresis, so tracker jitter at rest is not a reversal.
            return String(turningPoints(v, JITTER_PX).filter((i) => Math.abs(v[i]! - rest) >= 1).length)
          })
      }
    case "ui-repeat":
    case "ui-skip": {
      const rule = givens._tag === "ui-repeat" ? "duplicate-frames" : "dropped-frames"
      return {
        requests: [probe, check([rule])],
        conclude: (o) => {
          const found = findingsOf(o, rule)
          const frames =
            rule === "duplicate-frames" ? found.flatMap((f) => framesOf(clock, f)) : found.map((f) => f.index)
          const sorted = [...new Set(frames)].sort((a, b) => a - b)
          return sorted.length > 0
            ? Result.succeed(sorted.map((i) => `#${i}`).join(", "))
            : Result.fail(`check reported no ${rule}`)
        }
      }
    }
    case "ui-screen-change":
      return {
        requests: [probe, req("kymo_scan", { sample: "cuts", budget: 6 })],
        conclude: (o) => {
          const first = outputs(ScanOutput, o)
            .flatMap((r) => r.cuts)
            .flatMap((c) => resolveOn(clock, c.incoming))
            .sort((a, b) => a - b)[0]
          return frame(first, "scan reported no cut")
        }
      }
    case "ui-flash":
      return {
        requests: [probe, check(["flicker"])],
        conclude: (o) => frame(findingsOf(o, "flicker")[0]?.index, "check reported no flicker")
      }
    case "ui-safe-area":
      return {
        requests: [
          probe,
          check(["safe-area"], { box: givens.subject, safeMargin: givens.marginPercent / 100 })
        ],
        conclude: (o) => {
          if (outputs(CheckOutput, o).length === 0) return Result.fail("check returned no result")
          const first = findingsOf(o, "safe-area")
            .flatMap((f) => framesOf(clock, f))
            .sort((a, b) => a - b)[0]
          return frame(first, "check reported no safe-area finding")
        }
      }
    case "ui-reverse":
      return {
        requests: [probe, track(givens.subject, ["x"])],
        conclude: (o) =>
          Result.flatMap(trackEnding([o[1]!], ".x"), (x) =>
            Result.flatMap(carried(x), (v) =>
              frame(
                v.findIndex((xi, i) => i > 0 && xi < v[i - 1]! - 0.5),
                "the tracked knob never moves left"
              )
            )
          )
      }
    case "ui-compare":
      return {
        requests: [probe, track(givens.left, xywh), track(givens.right, xywh)],
        conclude: (o) =>
          Result.flatMap(frameSize(o), (size) =>
            Result.flatMap(trackedStates(o[1]), (left) =>
              Result.flatMap(trackedStates(o[2]), (right) => {
                const l = settleOf(left, size, JITTER_PX)
                const r = settleOf(right, size, JITTER_PX)
                return l && r
                  ? Result.succeed(String(l.index - r.index))
                  : Result.fail("a tracked sheet never settles")
              })
            )
          )
      }
  }
}
