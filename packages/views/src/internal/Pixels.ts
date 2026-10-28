import { RgbImage } from "@kymo/core"

export interface PixelRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Copy a region. The region must lie inside the image. */
export const crop = (image: RgbImage, r: PixelRect): RgbImage => {
  const out = new Uint8Array(r.width * r.height * 3)
  for (let y = 0; y < r.height; y++) {
    const from = ((r.y + y) * image.width + r.x) * 3
    out.set(image.data.subarray(from, from + r.width * 3), y * r.width * 3)
  }
  return RgbImage.make(r.width, r.height, out)
}

/** Inferno control points: black for "no change", through purple and orange, to pale yellow. */
const STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 4],
  [87, 16, 110],
  [188, 55, 84],
  [249, 142, 9],
  [252, 255, 164]
]

const COLORMAP: Uint8Array = (() => {
  const lut = new Uint8Array(256 * 3)
  for (let v = 0; v < 256; v++) {
    // Square-root response so small changes are visible next to large ones.
    const pos = Math.sqrt(v / 255) * (STOPS.length - 1)
    const i = Math.min(STOPS.length - 2, Math.floor(pos))
    const f = pos - i
    const a = STOPS[i]!
    const b = STOPS[i + 1]!
    for (let c = 0; c < 3; c++) lut[v * 3 + c] = Math.round(a[c]! + (b[c]! - a[c]!) * f)
  }
  return lut
})()

/** Per-pixel largest channel difference, mapped through the colormap. Images must be the same size. */
export const heatmap = (a: RgbImage, b: RgbImage): RgbImage => {
  const out = new Uint8Array(a.data.length)
  for (let p = 0; p < a.data.length; p += 3) {
    const d = Math.max(
      Math.abs(a.data[p]! - b.data[p]!),
      Math.abs(a.data[p + 1]! - b.data[p + 1]!),
      Math.abs(a.data[p + 2]! - b.data[p + 2]!)
    )
    out[p] = COLORMAP[d * 3]!
    out[p + 1] = COLORMAP[d * 3 + 1]!
    out[p + 2] = COLORMAP[d * 3 + 2]!
  }
  return RgbImage.make(a.width, a.height, out)
}

/** A pixel counts as moving when some channel differs from the background by more than this. */
const FOREGROUND_THRESHOLD = 24
const BACKGROUND_DIM = 0.5
/** Trail tints, oldest first: cool to warm, so direction of travel reads at a glance. */
const OLD_TINT: readonly [number, number, number] = [40, 120, 255]
const NEW_TINT: readonly [number, number, number] = [255, 150, 40]

/**
 * Onion skin: the per-pixel median (the static background) dimmed, then each frame's moving
 * pixels painted oldest to newest. Older frames are tinted and fainter; the newest is untouched.
 * Frames must share one size and be in time order.
 */
export const onionSkin = (frames: ReadonlyArray<RgbImage>): RgbImage => {
  const first = frames[0]!
  const n = frames.length
  const len = first.data.length
  const background = new Uint8Array(len)
  const column = new Array<number>(n)
  for (let p = 0; p < len; p++) {
    for (let k = 0; k < n; k++) column[k] = frames[k]!.data[p]!
    column.sort((x, y) => x - y)
    background[p] = column[n >> 1]!
  }
  const out = new Uint8Array(len)
  for (let p = 0; p < len; p++) out[p] = Math.round(background[p]! * BACKGROUND_DIM)
  frames.forEach((frame, k) => {
    const newest = k === n - 1
    const age = n === 1 ? 1 : k / (n - 1)
    const alpha = newest ? 1 : 0.3 + 0.5 * age
    const tint = OLD_TINT.map((c, i) => c + (NEW_TINT[i]! - c) * age)
    for (let p = 0; p < len; p += 3) {
      const moving =
        Math.abs(frame.data[p]! - background[p]!) > FOREGROUND_THRESHOLD ||
        Math.abs(frame.data[p + 1]! - background[p + 1]!) > FOREGROUND_THRESHOLD ||
        Math.abs(frame.data[p + 2]! - background[p + 2]!) > FOREGROUND_THRESHOLD
      if (!moving) continue
      for (let c = 0; c < 3; c++) {
        const src = newest ? frame.data[p + c]! : (frame.data[p + c]! + tint[c]!) / 2
        out[p + c] = Math.round(out[p + c]! * (1 - alpha) + src * alpha)
      }
    }
  })
  return RgbImage.make(first.width, first.height, out)
}
