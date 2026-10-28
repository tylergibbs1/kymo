/**
 * UI tasks from recorded browser truth. Each case names a capture and a question; the answer is
 * measured from what the browser laid out at every frame (Measure.ts). Nothing here opens a browser,
 * so the checked-in task file can be regenerated and compared in CI.
 */
import { Effect } from "effect"
import { UI_SOURCE_PREFIX } from "../Present.ts"
import { render } from "../Prompts.ts"
import { splitOf } from "../Split.ts"
import { classifyEasing, TruthMismatch } from "../Synthetic.ts"
import type { Answer, Box, Task, UiGivens } from "../Task.ts"
import { UI_CASES, type UiCase } from "./Cases.ts"
import {
  type Frame,
  type Located,
  type State,
  boxOf,
  fullyShown,
  mainAxis,
  progressOf,
  settleOf,
  startOf,
  stutters,
  turningPoints
} from "./Measure.ts"
import { type CaptureTruth, type TruthFile, captureKey, series } from "./Truth.ts"

/** Overshoot extremes this close to the 1 px line are too close to call; a case producing one is rejected. */
const AMBIGUOUS_PX: readonly [number, number] = [0.6, 1.6]

const fail = (id: string, message: string) =>
  Effect.fail(new TruthMismatch({ id, message: `${id}: ${message}` }))

const need = <A>(id: string, value: A | undefined, what: string): Effect.Effect<A, TruthMismatch> =>
  value === undefined ? fail(id, what) : Effect.succeed(value)

const statesOf = (id: string, truth: CaptureTruth, name: string) =>
  Effect.gen(function* () {
    const [x, y, w, h, opacity] = yield* Effect.forEach(["x", "y", "w", "h", "opacity"], (p) =>
      need(id, series(truth, `${name}.${p}`), `the capture recorded no ${name}.${p}`)
    )
    return Array.from({ length: truth.frames }, (_, i): State => ({
      x: x![i]!,
      y: y![i]!,
      w: w![i]!,
      h: h![i]!,
      opacity: opacity![i]!
    }))
  })

const frameOf = (truth: CaptureTruth): Frame => ({ width: truth.width, height: truth.height })

const at0 = (
  id: string,
  truth: CaptureTruth,
  states: ReadonlyArray<State>
): Effect.Effect<Box, TruthMismatch> =>
  need(id, boxOf(states[0]!, frameOf(truth)), "the element is not on screen at 0f")

const frameAnswer = (l: Located): Answer => ({ _tag: "frame", index: l.index, tolerance: l.tolerance })

/** Givens and answer for one case, measured from its capture. */
const truthOf = (
  k: UiCase,
  truth: CaptureTruth
): Effect.Effect<{ givens: UiGivens; answer: Answer }, TruthMismatch> =>
  Effect.gen(function* () {
    const f = frameOf(truth)
    switch (k.family) {
      case "ui-start":
      case "ui-settle": {
        const states = yield* statesOf(k.id, truth, k.target)
        const shown = fullyShown(states[0]!, f)
        const box = yield* need(
          k.id,
          boxOf(states[shown ? 0 : states.length - 1]!, f),
          "the element is never on screen"
        )
        const located =
          k.family === "ui-start"
            ? yield* need(k.id, startOf(states, f), "the element never visibly changes")
            : yield* need(k.id, settleOf(states, f), "the element is still moving at the last frame")
        return {
          givens: {
            _tag: k.family,
            element: k.element,
            subject: { box, seen: shown ? "first-frame" : "at-rest" }
          },
          answer: frameAnswer(located)
        }
      }
      case "ui-easing": {
        const states = yield* statesOf(k.id, truth, k.target)
        if (!fullyShown(states[0]!, f))
          return yield* fail(k.id, "an easing subject must be fully shown at 0f")
        const progress = progressOf(
          mainAxis(
            states.map((s) => s.x),
            states.map((s) => s.y)
          )
        )
        const start = Math.max(0, progress.findIndex((p) => Math.abs(p) > 0.001) - 1)
        const settled = progress.findIndex(
          (_, i) => i > start && progress.slice(i).every((p) => Math.abs(1 - p) < 0.001)
        )
        const label = classifyEasing(progress, start, settled < 0 ? progress.length - 1 : settled)
        if (label !== k.expect)
          return yield* fail(
            k.id,
            `the recorded motion reads as ${label ?? "no known easing"}, the case expects ${k.expect}`
          )
        return {
          givens: { _tag: "ui-easing", element: k.element, subject: yield* at0(k.id, truth, states) },
          answer: { _tag: "label", value: label }
        }
      }
      case "ui-overshoot": {
        const states = yield* statesOf(k.id, truth, k.target)
        const v = mainAxis(
          states.map((s) => s.x),
          states.map((s) => s.y)
        )
        const rest = v[v.length - 1]!
        const swings = turningPoints(v).map((i) => Math.abs(v[i]! - rest))
        const unclear = swings.find((a) => a >= AMBIGUOUS_PX[0] && a < AMBIGUOUS_PX[1])
        if (unclear !== undefined)
          return yield* fail(
            k.id,
            `a reversal ${unclear.toFixed(2)} px from rest is too close to the 1 px line`
          )
        return {
          givens: { _tag: "ui-overshoot", element: k.element, subject: yield* at0(k.id, truth, states) },
          answer: { _tag: "count", value: swings.filter((a) => a >= 1).length }
        }
      }
      case "ui-repeat":
      case "ui-skip": {
        const states = yield* statesOf(k.id, truth, k.target)
        const { repeats, skips } = stutters(states.map((s) => s.x))
        const [first, ...rest] = k.family === "ui-repeat" ? repeats : skips
        if (first === undefined)
          return yield* fail(k.id, `no ${k.family === "ui-repeat" ? "repeats" : "skips"} recorded`)
        return {
          givens: { _tag: k.family, subject: yield* at0(k.id, truth, states) },
          answer: { _tag: "frames", indices: [first, ...rest], tolerance: 0 }
        }
      }
      case "ui-screen-change": {
        const states = yield* statesOf(k.id, truth, k.target)
        const first = (threshold: number) => {
          const i = states.findIndex((s) => s.opacity >= threshold)
          return i < 0 ? undefined : i
        }
        const index = yield* need(k.id, first(0.02), "the next page never shows")
        const spread = Math.max(
          Math.abs((first(0.01) ?? index) - index),
          Math.abs((first(0.04) ?? index) - index)
        )
        return {
          givens: { _tag: "ui-screen-change" },
          answer: { _tag: "frame", index, tolerance: Math.max(1, spread) }
        }
      }
      case "ui-flash": {
        const states = yield* statesOf(k.id, truth, k.target)
        const lit = states.flatMap((s, i) => (s.opacity > 0.5 ? [i] : []))
        if (lit.length !== 1) return yield* fail(k.id, `expected one flash frame, recorded ${lit.length}`)
        return { givens: { _tag: "ui-flash" }, answer: { _tag: "frame", index: lit[0]!, tolerance: 0 } }
      }
      case "ui-safe-area": {
        const states = yield* statesOf(k.id, truth, k.target)
        const m = k.marginPercent / 100
        const out = states.findIndex(
          (s) =>
            s.x < m * f.width ||
            s.y < m * f.height ||
            s.x + s.w > (1 - m) * f.width ||
            s.y + s.h > (1 - m) * f.height
        )
        if (out <= 0)
          return yield* fail(
            k.id,
            out === 0 ? "the badge starts outside the safe area" : "the badge never leaves the safe area"
          )
        return {
          givens: {
            _tag: "ui-safe-area",
            subject: yield* at0(k.id, truth, states),
            marginPercent: k.marginPercent
          },
          answer: { _tag: "frame", index: out, tolerance: 1 }
        }
      }
      case "ui-reverse": {
        const states = yield* statesOf(k.id, truth, k.target)
        const index = states.findIndex((s, i) => i > 0 && s.x < states[i - 1]!.x - 0.5)
        if (index < 0) return yield* fail(k.id, "the knob never moves back")
        return {
          givens: { _tag: "ui-reverse", subject: yield* at0(k.id, truth, states) },
          answer: { _tag: "frame", index, tolerance: 1 }
        }
      }
      case "ui-compare": {
        const left = yield* statesOf(k.id, truth, k.left)
        const right = yield* statesOf(k.id, truth, k.right)
        const l = yield* need(k.id, settleOf(left, f), "the left variant is still moving at the end")
        const r = yield* need(k.id, settleOf(right, f), "the right variant is still moving at the end")
        const value = l.index - r.index
        const tolerance = Math.max(l.tolerance, r.tolerance)
        if (Math.abs(value) <= tolerance)
          return yield* fail(
            k.id,
            `the variants settle ${value} frames apart, inside the ${tolerance}-frame tolerance`
          )
        return {
          givens: {
            _tag: "ui-compare",
            left: yield* at0(k.id, truth, left),
            right: yield* at0(k.id, truth, right)
          },
          answer: { _tag: "delta", value, tolerance }
        }
      }
    }
  })

/** Build one task from its capture's truth. */
export const buildUiTask = (k: UiCase, truth: CaptureTruth): Effect.Effect<Task, TruthMismatch> =>
  Effect.map(truthOf(k, truth), ({ givens, answer }) => ({
    id: k.id,
    split: splitOf(k.id),
    source: `${UI_SOURCE_PREFIX}${truth.key}`,
    clock: { rate: { num: truth.fps, den: 1 }, frames: truth.frames },
    givens,
    prompt: render(givens, answer._tag),
    answer,
    followUps: []
  }))

/**
 * Every UI task, in case order. A case whose capture is not in the truth file (a new case, or a scene
 * edited since the last capture) fails with a hint to recapture.
 */
export const generateUi = (truth: TruthFile, cases: ReadonlyArray<UiCase> = UI_CASES) =>
  Effect.forEach(cases, (k) => {
    const key = captureKey(k.capture)
    const found = truth.captures.find((c) => c.key === key)
    return found === undefined
      ? fail(k.id, `no recorded truth for capture ${key}: run \`bun run eval -- ui-capture\``)
      : buildUiTask(k, found)
  })
