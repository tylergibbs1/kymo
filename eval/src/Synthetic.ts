/**
 * The synthetic task set. Each case is a scene spec plus the question family; the answer is read back
 * from the opened source's ground truth (truth markers and tracks), never typed in here.
 */
import type { KymoError, Source, Track } from "@kymo/core"
import { Sources, SyntheticAdapter } from "@kymo/sources"
import { Effect, Layer, Schema } from "effect"
import { render } from "./Prompts.ts"
import { splitOf } from "./Split.ts"
import { PRESETS, type Preset, bezierAt } from "@kymo/analysis"
import type { Answer, Box, EasingLabel, SyntheticGivens, Task } from "./Task.ts"

/** Ground truth that does not say what the case expected: a defect in the case list or the scene. */
export class TruthMismatch extends Schema.TaggedError<TruthMismatch>()("TruthMismatch", {
  id: Schema.String,
  message: Schema.String
}) {}

type Family = SyntheticGivens["_tag"]

interface Case {
  readonly id: string
  readonly family: Family
  readonly scene: string
  readonly params: Readonly<Record<string, string | number>>
  /** For easing cases: the label the parameters are meant to produce; the track must agree. */
  readonly expect?: EasingLabel
}

const SIZE = "640x360"

const c = (
  id: string,
  family: Family,
  scene: string,
  params: Readonly<Record<string, string | number>>,
  expect?: EasingLabel
): Case => ({ id, family, scene, params, ...(expect ? { expect } : {}) })

const EASINGS: ReadonlyArray<readonly [EasingLabel, string, string]> = [
  ["linear", "linear", "linear"],
  ["ease-in", "ease-in", "ease-in"],
  ["ease-out", "ease-out", "ease-out"],
  ["ease-in-out", "ease-in-out", "ease-in-out"],
  ["spring", "spring(170,12)", "spring(120,10)"]
]

export const CASES: ReadonlyArray<Case> = [
  c("impact-30fps-f20", "impact", "bounce", { fps: 30, frames: 90, impact: 20 }),
  c("impact-30fps-f24", "impact", "bounce", { fps: 30, frames: 90, impact: 24, decay: 0.5 }),
  c("impact-30fps-f30", "impact", "bounce", { fps: 30, frames: 90, impact: 30 }),
  c("impact-30fps-f37", "impact", "bounce", { fps: 30, frames: 90, impact: 37 }),
  c("impact-24fps-f18", "impact", "bounce", { fps: 24, frames: 72, impact: 18 }),
  c("impact-60fps-f50", "impact", "bounce", { fps: 60, frames: 180, impact: 50 }),

  c("bounces-1", "bounces", "bounce", { frames: 90, impact: 30, bounces: 1 }),
  c("bounces-2", "bounces", "bounce", { frames: 90, impact: 25, period: 30, bounces: 2 }),
  c("bounces-3", "bounces", "bounce", { frames: 120, impact: 20, period: 24, decay: 0.7, bounces: 3 }),
  c("bounces-4", "bounces", "bounce", { frames: 120, impact: 20, period: 24, decay: 0.7, bounces: 4 }),
  c("bounces-5", "bounces", "bounce", { frames: 120, impact: 20, period: 24, decay: 0.7, bounces: 5 }),
  c("bounces-6", "bounces", "bounce", { frames: 120, impact: 15, period: 20, decay: 0.75, bounces: 6 }),

  ...EASINGS.flatMap(([label, a, b]) => [
    c(
      `easing-${label}-30fps`,
      "easing",
      "ease",
      { fps: 30, frames: 90, easing: a, start: 10, end: 70 },
      label
    ),
    c(`easing-${label}-24fps`, "easing", "ease", { fps: 24, frames: 72, easing: b, start: 6, end: 48 }, label)
  ]),

  c("flicker-f12", "flicker", "flicker", { frames: 90, at: 12, gain: 60 }),
  c("flicker-f45-faint", "flicker", "flicker", { frames: 90, at: 45, gain: 40 }),
  c("flicker-f70-strong", "flicker", "flicker", { frames: 90, at: 70, gain: 90 }),
  c("flicker-24fps-f30", "flicker", "flicker", { fps: 24, frames: 72, at: 30, gain: 50 }),
  c("flicker-60fps-dark", "flicker", "flicker", { fps: 60, frames: 120, at: 97, gain: -60 }),

  c("safe-area-10pct-f54", "safe-area", "safe-area", { frames: 90, margin: "10", exit: 54 }),
  c("safe-area-5pct-f60", "safe-area", "safe-area", { frames: 90, margin: "5", exit: 60 }),
  c("safe-area-10pct-f30", "safe-area", "safe-area", { frames: 60, margin: "10", exit: 30 }),
  c("safe-area-24fps-5pct", "safe-area", "safe-area", { fps: 24, frames: 72, margin: "5", exit: 40 }),
  c("safe-area-60fps-10pct", "safe-area", "safe-area", { fps: 60, frames: 150, margin: "10", exit: 100 }),

  c("cut-hard-f45", "cut", "cut", { frames: 90, at: 45 }),
  c("cut-hard-f23", "cut", "cut", { frames: 90, at: 23 }),
  c("cut-hard-24fps-f70", "cut", "cut", { fps: 24, frames: 96, at: 70 }),
  c("cut-fade6-f40", "cut", "cut", { frames: 90, at: 40, fade: 6 }),
  c("cut-fade10-f30", "cut", "cut", { frames: 90, at: 30, fade: 10 }),

  c("dropped-default", "dropped", "dropped", { frames: 90 }),
  c("dropped-single", "dropped", "dropped", { frames: 90, dups: "12" }),
  c("dropped-pair", "dropped", "dropped", { frames: 90, dups: "20,45,46" }),
  c("dropped-24fps", "dropped", "dropped", { fps: 24, frames: 72, dups: "30,60" }),
  c("dropped-run", "dropped", "dropped", { frames: 90, dups: "5,50,51,52" })
]

export const specOf = (k: Case): string => {
  const query = new URLSearchParams({ size: SIZE })
  for (const [key, value] of Object.entries(k.params)) query.set(key, String(value))
  // URLSearchParams escapes "(" and ","; the synthetic grammar takes them raw.
  return `synthetic:${k.scene}?${decodeURIComponent(query.toString())}`
}

const markerIndices = (source: Source, pattern: RegExp): Array<number> =>
  source.timeline.markers.filter((m) => pattern.test(m.name)).map((m) => m.index)

const sample = (track: Track, i: number): number => {
  const v = track.samples[i]
  if (v === undefined || v === null) throw new Error(`${track.name} has no sample at #${i}`)
  return v
}

/** The subject's box at 0f from the `box.*` truth tracks, grown to whole pixels. */
const subjectAt0 = (source: Source) =>
  Effect.gen(function* () {
    const [x, y, w, h] = yield* Effect.forEach(["box.x", "box.y", "box.w", "box.h"], (n) => source.track(n))
    const x0 = Math.floor(sample(x!, 0))
    const y0 = Math.floor(sample(y!, 0))
    return {
      x: x0,
      y: y0,
      w: Math.ceil(sample(x!, 0) + sample(w!, 0)) - x0,
      h: Math.ceil(sample(y!, 0) + sample(h!, 0)) - y0
    } satisfies Box
  })

/** Farther than this from every preset, a motion has no named easing. */
const MAX_PRESET_RMS = 0.05

/**
 * The easing a motion follows: `spring` if it overshoots, else the CSS preset whose curve it is closest
 * to (RMS over the motion), or undefined if none is within `MAX_PRESET_RMS`.
 */
export const classifyEasing = (
  progress: ReadonlyArray<number>,
  start: number,
  end: number,
  /** Progress above this counts as overshoot. Measured tracks need slack for tracker noise. */
  overshoot = 1.001
): EasingLabel | undefined => {
  if (progress.some((p) => p > overshoot)) return "spring"
  const span = end - start
  const rms = (preset: Preset) => {
    let sum = 0
    for (let i = 0; i <= span; i++) sum += (progress[start + i]! - bezierAt(PRESETS[preset], i / span)) ** 2
    return Math.sqrt(sum / (span + 1))
  }
  const [best] = (Object.keys(PRESETS) as Array<Preset>)
    .map((preset) => ({ preset, error: rms(preset) }))
    .sort((a, b) => a.error - b.error)
  return best !== undefined && best.error <= MAX_PRESET_RMS ? best.preset : undefined
}

const one = (id: string, values: ReadonlyArray<number>, what: string) =>
  values.length === 1
    ? Effect.succeed(values[0]!)
    : Effect.fail(new TruthMismatch({ id, message: `expected one ${what} marker, found ${values.length}` }))

/** Givens and answer for one case, read from the opened source. */
const truthOf = (
  k: Case,
  source: Source
): Effect.Effect<{ givens: SyntheticGivens; answer: Answer }, KymoError | TruthMismatch> =>
  Effect.gen(function* () {
    switch (k.family) {
      case "impact": {
        const impacts = markerIndices(source, /^impact\d+$/)
        if (impacts.length === 0) return yield* new TruthMismatch({ id: k.id, message: "no impact markers" })
        return {
          givens: { _tag: "impact", subject: yield* subjectAt0(source) },
          answer: { _tag: "frame", index: Math.min(...impacts), tolerance: 1 }
        }
      }
      case "bounces":
        return {
          givens: { _tag: "bounces", subject: yield* subjectAt0(source) },
          answer: { _tag: "count", value: markerIndices(source, /^impact\d+$/).length }
        }
      case "easing": {
        const start = yield* one(k.id, markerIndices(source, /^motion_start$/), "motion_start")
        const progress = (yield* source.track("ease.progress")).samples.map((v) => v ?? 0)
        const ends = markerIndices(source, /^motion_end$/)
        const label = classifyEasing(progress, start, ends[0] ?? progress.length - 1)
        if (label === undefined || label !== k.expect) {
          return yield* new TruthMismatch({
            id: k.id,
            message: `the progress track reads as ${label ?? "no known easing"}, the case expects ${k.expect}`
          })
        }
        return {
          givens: { _tag: "easing", subject: yield* subjectAt0(source) },
          answer: { _tag: "label", value: label }
        }
      }
      case "flicker":
        return {
          givens: { _tag: "flicker" },
          answer: {
            _tag: "frame",
            index: yield* one(k.id, markerIndices(source, /^flicker$/), "flicker"),
            tolerance: 0
          }
        }
      case "safe-area": {
        const marginPercent = k.params["margin"] === "5" ? 5 : 10
        return {
          givens: { _tag: "safe-area", subject: yield* subjectAt0(source), marginPercent },
          answer: {
            _tag: "frame",
            index: yield* one(k.id, markerIndices(source, /^exit_safe$/), "exit_safe"),
            tolerance: 1
          }
        }
      }
      case "cut": {
        const fade = Number(k.params["fade"] ?? 0)
        return {
          givens: { _tag: "cut" },
          answer: {
            _tag: "frame",
            index: yield* one(k.id, markerIndices(source, /^cut$/), "cut"),
            tolerance: fade
          }
        }
      }
      case "dropped": {
        const [first, ...rest] = markerIndices(source, /^dup\d+$/).sort((a, b) => a - b)
        if (first === undefined) return yield* new TruthMismatch({ id: k.id, message: "no dup markers" })
        return {
          givens: { _tag: "dropped" },
          answer: { _tag: "frames", indices: [first, ...rest], tolerance: 0 }
        }
      }
    }
  })

const SyntheticSources = Sources.layerFrom(SyntheticAdapter).pipe(Layer.provide(SyntheticAdapter.layer))

/** Build one task by opening its scene and reading the answer from ground truth. */
export const buildTask = (k: Case): Effect.Effect<Task, KymoError | TruthMismatch> =>
  Effect.gen(function* () {
    const sources = yield* Sources
    const source = yield* sources.open(specOf(k), "truth")
    const { givens, answer } = yield* truthOf(k, source)
    const t = source.timeline
    return {
      id: k.id,
      split: splitOf(k.id),
      source: specOf(k),
      clock: { rate: t.rate, frames: t.frameCount },
      givens,
      prompt: render(givens, answer._tag),
      answer,
      followUps: []
    } satisfies Task
  }).pipe(Effect.scoped, Effect.provide(SyntheticSources))

/** Every synthetic task, in case order. */
export const generate = (cases: ReadonlyArray<Case> = CASES) => Effect.forEach(cases, buildTask)
