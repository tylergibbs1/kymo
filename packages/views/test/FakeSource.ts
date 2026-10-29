import {
  Address,
  type DecodedFrame,
  type FrameIndex,
  InvalidInput,
  RgbImage,
  type Source,
  type Timeline,
  type Track,
  rate,
  secondsAt
} from "@kymo/core"
import { Effect, Stream } from "effect"

export const SQUARE = 40
export const BACKGROUND: readonly [number, number, number] = [30, 30, 30]
export const SQUARE_RGB: readonly [number, number, number] = [240, 240, 240]

export interface FakeOptions {
  readonly handle?: string
  readonly width?: number
  readonly height?: number
  readonly frames?: number
  /** Square's top-left x at frame i. Default moves 2 px per frame, wrapping. */
  readonly squareX?: (i: number) => number
  /**
   * Encoder-like noise: every pixel brightened by up to this many levels, in a pattern that changes
   * every frame, as H.264 re-encodes a still picture. Default 0.
   */
  readonly noise?: number
}

/** Draws frame i at full size: a flat background with a white square. */
const draw = (width: number, height: number, x: number, y: number): RgbImage => {
  const image = RgbImage.blank(width, height, BACKGROUND)
  for (let row = y; row < Math.min(height, y + SQUARE); row++)
    for (let col = x; col < Math.min(width, x + SQUARE); col++)
      image.data.set(SQUARE_RGB, (row * width + col) * 3)
  return image
}

/** Brighten each pixel by up to `amplitude` levels, in a pattern that differs from frame to frame. */
const speckle = (image: RgbImage, frame: number, amplitude: number): RgbImage => {
  if (amplitude === 0) return image
  const d = image.data
  for (let p = 0; p < d.length; p += 3) {
    const n = ((p / 3) * 7 + frame * 13) % (amplitude + 1)
    for (let c = 0; c < 3; c++) d[p + c] = Math.min(255, d[p + c]! + n)
  }
  return image
}

/** Nearest-neighbour downscale so the long edge is at most `maxEdge`, as a real adapter would. */
const shrink = (image: RgbImage, maxEdge: number | undefined): RgbImage => {
  const long = Math.max(image.width, image.height)
  if (maxEdge === undefined || long <= maxEdge) return image
  const s = maxEdge / long
  const w = Math.max(1, Math.round(image.width * s))
  const h = Math.max(1, Math.round(image.height * s))
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const from = (Math.floor(y / s) * image.width + Math.floor(x / s)) * 3
      out.set(image.data.subarray(from, from + 3), (y * w + x) * 3)
    }
  return RgbImage.make(w, h, out)
}

export const fakeSource = (o: FakeOptions = {}): Source & { readonly reads: Array<number | undefined> } => {
  const width = o.width ?? 320
  const height = o.height ?? 180
  const count = o.frames ?? 300
  const r = rate(30)
  const squareX = o.squareX ?? ((i: number) => (10 + i * 2) % (width - SQUARE))
  const squareY = Math.floor((height - SQUARE) / 2)
  const reads: Array<number | undefined> = []
  const timeline: Timeline = {
    handle: o.handle ?? "clip1",
    kind: "synthetic",
    input: "fake",
    rate: r,
    rateFrom: "source",
    fps: 30,
    frameCount: count,
    duration: Address.format(r, count),
    durationSeconds: count / 30,
    size: { width, height },
    seekable: true,
    live: false,
    vfr: false,
    tracks: [
      { name: "x", unit: "px" },
      { name: "y", unit: "px" },
      { name: "speed", unit: "px/s" }
    ],
    markers: []
  }
  const tracks: Record<string, Track> = {
    x: { name: "x", unit: "px", samples: Array.from({ length: count }, (_, i) => squareX(i) + SQUARE / 2) },
    y: { name: "y", unit: "px", samples: Array.from({ length: count }, () => squareY + SQUARE / 2) },
    speed: {
      name: "speed",
      unit: "px/s",
      samples: Array.from({ length: count }, (_, i) => (i % 50 < 5 ? null : Math.sin(i / 10) * 60 + 60))
    }
  }
  return {
    timeline,
    reads,
    readFrames: (indices: ReadonlyArray<FrameIndex>, options) => {
      reads.push(options?.maxEdge)
      return Stream.fromIterable(
        indices.map((index): DecodedFrame => ({
          index,
          t: secondsAt(r, index),
          image: shrink(
            speckle(draw(width, height, squareX(index), squareY), index, o.noise ?? 0),
            options?.maxEdge
          )
        }))
      )
    },
    track: (name: string) => {
      const t = tracks[name]
      return t
        ? Effect.succeed(t)
        : Effect.fail(new InvalidInput({ message: `No track ${name}.`, hint: "Use x, y or speed." }))
    }
  }
}
