import { FrameRef, InvalidInput, type KymoError, type Size, type Source, Track } from "@kymo/core"
import { Effect, Result, Schema, Stream } from "effect"
import { type Gray, toGray } from "./Pixels.ts"
import type { FrameRange } from "./Range.ts"
import { round } from "./Stats.ts"

const Positive = Schema.Finite.check(Schema.isGreaterThan(0))

/** An axis-aligned box in source pixels. */
export const Box = Schema.Struct({ x: Schema.Finite, y: Schema.Finite, w: Positive, h: Positive })
export type Box = typeof Box.Type

const BOX_EXAMPLE = "x,y,w,h in source pixels, e.g. 120,80,64,64"

/** Parse `x,y,w,h` and check the box lies inside a frame of `size`. */
export const parseBox = (text: string, size: Size): Result.Result<Box, InvalidInput> => {
  const parts = text.split(",").map((p) => p.trim())
  const nums = parts.map(Number)
  if (parts.length !== 4 || parts.some((p) => p === "") || nums.some((n) => !Number.isFinite(n))) {
    return Result.fail(
      new InvalidInput({ message: `"${text}" is not a box.`, hint: `Write ${BOX_EXAMPLE}.` })
    )
  }
  const [x, y, w, h] = nums as [number, number, number, number]
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > size.width || y + h > size.height) {
    return Result.fail(
      new InvalidInput({
        message: `Box ${text} is not inside the ${size.width}x${size.height} frame.`,
        hint: `Use a box with positive size inside 0,0,${size.width},${size.height}; ${BOX_EXAMPLE}.`
      })
    )
  }
  return Result.succeed({ x, y, w, h })
}

/**
 * A region followed over time, as four px Tracks named `<name>.x`, `.y`, `.w`, `.h`.
 * Template matching and (later) DOM selectors both produce this shape.
 */
export const RegionTrack = Schema.Struct({
  /** The region's name and track prefix: `box`, or a selector such as `#hero`. */
  name: Schema.String,
  method: Schema.Literals(["template", "selector"]),
  from: FrameRef,
  to: FrameRef,
  x: Track,
  y: Track,
  w: Track,
  h: Track,
  /** Match quality per frame, 0..1. Position samples are null where the region was lost. */
  confidence: Track
})
export type RegionTrack = typeof RegionTrack.Type

export interface TrackOptions {
  /** Track prefix. Default `box`. */
  readonly name?: string
  /** Long edge to decode at; smaller is faster, larger is more precise. Default 480. */
  readonly maxEdge?: number
}

/** Below this match quality the region counts as lost for that frame. */
const LOST = 0.5
/** At or above this, the template is refreshed from the new match. */
const REFRESH = 0.8

interface Patch {
  readonly w: number
  readonly h: number
  readonly data: Float32Array
}

const cut = (g: Gray, x: number, y: number, w: number, h: number): Patch => {
  const data = new Float32Array(w * h)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) data[r * w + c] = g.data[(y + r) * g.width + x + c]!
  }
  return { w, h, data }
}

/** Sum of absolute differences, or Infinity as soon as it exceeds `limit` (so a cut-short sum never wins). */
const sad = (g: Gray, t: Patch, x: number, y: number, limit: number): number => {
  let s = 0
  for (let r = 0; r < t.h; r++) {
    const row = (y + r) * g.width + x
    for (let c = 0; c < t.w; c++) s += Math.abs(g.data[row + c]! - t.data[r * t.w + c]!)
    if (s > limit) return Infinity
  }
  return s
}

/** Normalised cross-correlation mapped to 0..1; for flat patches, 1 minus the mean difference. */
const quality = (a: Patch, b: Patch): number => {
  const n = a.data.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a.data[i]!
    mb += b.data[i]!
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  let diff = 0
  for (let i = 0; i < n; i++) {
    const x = a.data[i]! - ma
    const y = b.data[i]! - mb
    num += x * y
    da += x * x
    db += y * y
    diff += Math.abs(a.data[i]! - b.data[i]!)
  }
  const flat = 1e-6 * n
  return da < flat || db < flat
    ? Math.max(0, 1 - diff / (n * 255) / 0.1)
    : Math.max(0, num / Math.sqrt(da * db))
}

/** Offset of a parabola's vertex through (-1, a), (0, b), (1, c), in -0.5..0.5. */
const vertex = (a: number, b: number, c: number): number => {
  const d = a - 2 * b + c
  return d <= 0 ? 0 : Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)))
}

interface State {
  template: Patch
  readonly original: Patch
  x: number
  y: number
  vx: number
  vy: number
  radius: number
}

const match = (g: Gray, s: State, baseRadius: number) => {
  const { template: t } = s
  const maxX = g.width - t.w
  const maxY = g.height - t.h
  const px = Math.round(s.x + s.vx)
  const py = Math.round(s.y + s.vy)
  let best = Infinity
  let bx = Math.max(0, Math.min(maxX, px))
  let by = Math.max(0, Math.min(maxY, py))
  for (let y = Math.max(0, py - s.radius); y <= Math.min(maxY, py + s.radius); y++) {
    for (let x = Math.max(0, px - s.radius); x <= Math.min(maxX, px + s.radius); x++) {
      const v = sad(g, t, x, y, best)
      if (v < best || (v === best && Math.hypot(x - px, y - py) < Math.hypot(bx - px, by - py))) {
        best = v
        bx = x
        by = y
      }
    }
  }
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x > maxX || y > maxY ? best : sad(g, t, x, y, Infinity)
  const sx = vertex(at(bx - 1, by), best, at(bx + 1, by))
  const sy = vertex(at(bx, by - 1), best, at(bx, by + 1))
  const patch = cut(g, bx, by, t.w, t.h)
  const q = quality(t, patch)
  if (q < LOST) {
    s.radius = Math.min(4 * baseRadius, s.radius * 2)
    s.vx = 0
    s.vy = 0
    return { x: null, y: null, q }
  }
  s.vx = bx - s.x
  s.vy = by - s.y
  s.x = bx
  s.y = by
  s.radius = baseRadius
  // Re-anchor on the original appearance when it still matches; otherwise follow the new look.
  if (quality(s.original, patch) >= REFRESH) s.template = s.original
  else if (q >= REFRESH) s.template = patch
  return { x: bx + sx, y: by + sy, q }
}

/**
 * Follow `box` (source px, at `range.first`) through `range` by template matching
 * on grayscale: SAD inside a search window around the predicted position,
 * sub-pixel refinement, and template refresh while the match is good.
 */
export const trackRegion = (
  source: Source,
  range: FrameRange,
  box: Box,
  options: TrackOptions = {}
): Effect.Effect<RegionTrack, KymoError> =>
  Effect.suspend(() => {
    const name = options.name ?? "box"
    const n = range.frameCount
    const nulls = () => Array.from({ length: n }, (): number | null => null)
    const xs = nulls()
    const ys = nulls()
    const ws = nulls()
    const hs = nulls()
    const qs = nulls()
    let state: State | undefined
    let scale = 1
    let baseRadius = 0
    // The template sits on whole pixels; this is how far the requested box was from them.
    let offset = { x: 0, y: 0 }
    const size = source.timeline.size
    if (size === null) {
      return Effect.fail(
        new InvalidInput({
          message: `${source.timeline.handle} has no pixels to track.`,
          hint: "Track a region on a video, image sequence or web source; telemetry has tracks already."
        })
      )
    }
    const stream = source.readFrames(range.indices(), { maxEdge: options.maxEdge ?? 480 })
    return Stream.runForEach(stream, (frame) =>
      Effect.sync(() => {
        const g = toGray(frame.image)
        const i = frame.index
        if (state === undefined) {
          scale = g.width / size.width
          const tw = Math.max(2, Math.min(g.width, Math.round(box.w * scale)))
          const th = Math.max(2, Math.min(g.height, Math.round(box.h * scale)))
          const tx = Math.max(0, Math.min(g.width - tw, Math.round(box.x * scale)))
          const ty = Math.max(0, Math.min(g.height - th, Math.round(box.y * scale)))
          const template = cut(g, tx, ty, tw, th)
          baseRadius = Math.max(6, Math.round(0.75 * Math.max(tw, th)))
          state = { template, original: template, x: tx, y: ty, vx: 0, vy: 0, radius: baseRadius }
          offset = { x: box.x - tx / scale, y: box.y - ty / scale }
          xs[i] = round(box.x, 2)
          ys[i] = round(box.y, 2)
          qs[i] = 1
        } else {
          const m = match(g, state, baseRadius)
          qs[i] = round(m.q, 3)
          if (m.x !== null && m.y !== null) {
            xs[i] = round(m.x / scale + offset.x, 2)
            ys[i] = round(m.y / scale + offset.y, 2)
          }
        }
        if (xs[i] !== null) {
          ws[i] = round(box.w, 2)
          hs[i] = round(box.h, 2)
        }
      })
    ).pipe(
      Effect.as({
        name,
        method: "template" as const,
        from: range.ref(range.first),
        to: range.ref(range.last),
        x: { name: `${name}.x`, unit: "px", samples: xs },
        y: { name: `${name}.y`, unit: "px", samples: ys },
        w: { name: `${name}.w`, unit: "px", samples: ws },
        h: { name: `${name}.h`, unit: "px", samples: hs },
        confidence: { name: `${name}.confidence`, unit: "0..1", samples: qs }
      })
    )
  })
