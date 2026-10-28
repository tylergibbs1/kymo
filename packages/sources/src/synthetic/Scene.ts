import { InvalidInput, type Rate, type RgbImage, type Size, type Track } from "@kymo/core"
import { Result, Schema } from "effect"
import { IntParam, RateParam, SizeParam, decodeParams } from "../Params.ts"
import type { Rgb } from "./Canvas.ts"

/** The clock and canvas every scene renders onto. */
export interface Clip {
  readonly rate: Rate
  readonly frames: number
  readonly size: Size
}

/** A box in pixels, top-left origin. Every scene's ground truth is expressed as one of these per frame. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly opacity: number
}

/** A scene, built for one clip: ground truth plus a deterministic renderer. */
export interface SceneModel {
  readonly markers: ReadonlyArray<{ readonly name: string; readonly index: number }>
  /** Every track has exactly `clip.frames` samples. */
  readonly tracks: ReadonlyArray<Track>
  readonly render: (index: number) => RgbImage
}

export interface Scene {
  readonly name: string
  /** One line for hints: what the scene shows and its parameters. */
  readonly summary: string
  readonly build: (
    params: Readonly<Record<string, string>>
  ) => Result.Result<{ readonly clip: Clip; readonly model: SceneModel }, InvalidInput>
}

const clipFields = {
  fps: Schema.optionalKey(RateParam),
  frames: Schema.optionalKey(IntParam(1, 100_000)),
  size: Schema.optionalKey(SizeParam)
}

export const CLIP_DEFAULTS: Clip = {
  rate: { num: 30, den: 1 },
  frames: 90,
  size: { width: 640, height: 360 }
}

/**
 * Define a scene from its parameter fields (all optional; defaults may depend on the clip) and a
 * builder. Clip parameters (fps, frames, size) are shared by every scene.
 */
export const defineScene = <const F extends Schema.Struct.Fields>(def: {
  readonly name: string
  readonly summary: string
  readonly params: F
  readonly make: (clip: Clip, params: Schema.Struct<F>["Type"]) => Result.Result<SceneModel, InvalidInput>
}): Scene => {
  const schema = Schema.Struct({ ...clipFields, ...def.params })
  return {
    name: def.name,
    summary: def.summary,
    build: (raw) =>
      Result.flatMap(decodeParams(schema, raw, `synthetic:${def.name}`), (p) => {
        const typed = p as { fps?: Rate; frames?: number; size?: Size }
        const clip: Clip = {
          rate: typed.fps ?? CLIP_DEFAULTS.rate,
          frames: typed.frames ?? CLIP_DEFAULTS.frames,
          size: typed.size ?? CLIP_DEFAULTS.size
        }
        return Result.map(def.make(clip, p as Schema.Struct<F>["Type"]), (model) => ({ clip, model }))
      })
  }
}

/** Fail a scene build with an actionable message. */
export const invalid = (scene: string, message: string, hint: string) =>
  Result.fail(new InvalidInput({ message: `synthetic:${scene}: ${message}`, hint }))

/** The five `box.*` tracks from a box per frame. */
export const boxTracks = (boxes: ReadonlyArray<Box>): Array<Track> => [
  { name: "box.x", unit: "px", samples: boxes.map((b) => b.x) },
  { name: "box.y", unit: "px", samples: boxes.map((b) => b.y) },
  { name: "box.w", unit: "px", samples: boxes.map((b) => b.w) },
  { name: "box.h", unit: "px", samples: boxes.map((b) => b.h) },
  { name: "box.opacity", unit: "ratio", samples: boxes.map((b) => b.opacity) }
]

/** `frames` values of f(i), i = 0..frames-1. */
export const perFrame = <A>(clip: Clip, f: (index: number) => A): Array<A> =>
  Array.from({ length: clip.frames }, (_, i) => f(i))

export const COLORS = {
  background: [24, 26, 32],
  subject: [236, 236, 236],
  accent: [64, 160, 255],
  wall: [120, 120, 128],
  warm: [214, 128, 52],
  navy: [20, 32, 72]
} as const satisfies Record<string, Rgb>
