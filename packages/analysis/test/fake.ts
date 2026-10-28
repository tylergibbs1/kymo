import {
  Address,
  type DecodedFrame,
  InvalidInput,
  type Marker,
  RgbImage,
  type Source,
  type Timeline,
  type Track,
  rate,
  secondsAt
} from "@kymo/core"
import { Effect, Stream } from "effect"

export const W = 64
export const H = 48

export type Rgb = readonly [number, number, number]

/** A drawable frame: a background (flat or textured) with rectangles on top. */
export interface Scene {
  readonly background: Rgb
  /** Deterministic per-pixel noise amplitude on the background, so shots have distinct histograms. */
  readonly texture?: number
  readonly rects?: ReadonlyArray<{ x: number; y: number; w: number; h: number; rgb: Rgb }>
}

const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export const draw = (scene: Scene): RgbImage => {
  const img = RgbImage.blank(W, H, scene.background)
  const d = img.data
  const amp = scene.texture ?? 0
  if (amp > 0) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const n = (hash(x, y) - 0.5) * 2 * amp
        for (let c = 0; c < 3; c++) {
          const p = (y * W + x) * 3 + c
          d[p] = Math.max(0, Math.min(255, d[p]! + n))
        }
      }
    }
  }
  for (const r of scene.rects ?? []) {
    for (let y = Math.max(0, r.y); y < Math.min(H, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(W, r.x + r.w); x++) {
        const p = (y * W + x) * 3
        d[p] = r.rgb[0]
        d[p + 1] = r.rgb[1]
        d[p + 2] = r.rgb[2]
      }
    }
  }
  return img
}

/** A textured square: SAD has something to lock on to. */
export const texturedSquare = (x: number, y: number, size: number): NonNullable<Scene["rects"]> => {
  const out: Array<{ x: number; y: number; w: number; h: number; rgb: Rgb }> = []
  const half = size / 2
  out.push({ x, y, w: size, h: size, rgb: [230, 230, 230] })
  out.push({ x, y, w: half, h: half, rgb: [40, 160, 220] })
  out.push({ x: x + half, y: y + half, w: half, h: half, rgb: [220, 60, 40] })
  return out
}

export interface FakeOptions {
  readonly frames: number
  readonly fps?: number
  readonly scene: (index: number) => Scene
  readonly tracks?: ReadonlyArray<Track>
  readonly markers?: ReadonlyArray<Marker>
  readonly size?: { width: number; height: number } | null
}

/** A Source whose frames are drawn on demand: nothing is held in memory. */
export const fakeSource = (options: FakeOptions): Source => {
  const r = rate(options.fps ?? 30)
  const tracks = options.tracks ?? []
  const timeline: Timeline = {
    handle: "fake",
    kind: "synthetic",
    input: "fake://test",
    rate: r,
    fps: options.fps ?? 30,
    frameCount: options.frames,
    duration: Address.format(r, options.frames),
    durationSeconds: options.frames / (options.fps ?? 30),
    size: options.size === undefined ? { width: W, height: H } : options.size,
    seekable: true,
    live: false,
    vfr: false,
    tracks: tracks.map((t) => ({ name: t.name, unit: t.unit })),
    markers: options.markers ?? []
  }
  return {
    timeline,
    readFrames: (indices) =>
      Stream.fromIterable(indices).pipe(
        Stream.map((index): DecodedFrame => ({
          index,
          t: secondsAt(r, index),
          image: draw(options.scene(index))
        }))
      ),
    track: (name) => {
      const t = tracks.find((x) => x.name === name)
      return t
        ? Effect.succeed(t)
        : Effect.fail(new InvalidInput({ message: `no track ${name}`, hint: "use a listed track" }))
    }
  }
}

/** A track sampled from a function of the frame index. */
export const trackOf = (name: string, frames: number, f: (i: number) => number | null): Track => ({
  name,
  unit: "",
  samples: Array.from({ length: frames }, (_, i) => f(i))
})

/** CSS cubic-bezier sampled independently of the code under test: dense sweep of t, then interpolate on x. */
export const bezierCurve = (x1: number, y1: number, x2: number, y2: number) => {
  const c = (p1: number, p2: number, t: number) =>
    3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3
  const n = 20000
  const xs = Array.from({ length: n + 1 }, (_, k) => c(x1, x2, k / n))
  const ys = Array.from({ length: n + 1 }, (_, k) => c(y1, y2, k / n))
  return (x: number): number => {
    let k = 0
    while (k < n && xs[k + 1]! < x) k++
    const a = xs[k]!
    const b = xs[k + 1] ?? a
    const f = b === a ? 0 : (x - a) / (b - a)
    return ys[k]! + f * ((ys[k + 1] ?? ys[k]!) - ys[k]!)
  }
}
