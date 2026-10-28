import type { RgbImage } from "@kymo/core"

/**
 * A grey image as floats, in continuous coordinates: pixel (i, j) covers [i, i+1) × [j, j+1), so its
 * centre is (i + 0.5, j + 0.5). Halving a level halves every coordinate exactly.
 */
export interface Plane {
  readonly width: number
  readonly height: number
  readonly data: Float32Array
}

export const planeOf = (image: RgbImage): Plane => {
  const n = image.width * image.height
  const out = new Float32Array(n)
  const src = image.data
  for (let p = 0, i = 0; p < n; p++, i += 3)
    out[p] = 0.299 * src[i]! + 0.587 * src[i + 1]! + 0.114 * src[i + 2]!
  return { width: image.width, height: image.height, data: out }
}

/** Half size, each pixel the mean of the 2×2 block it covers. */
const halve = (p: Plane): Plane => {
  const width = Math.max(1, p.width >> 1)
  const height = Math.max(1, p.height >> 1)
  const out = new Float32Array(width * height)
  const d = p.data
  for (let y = 0; y < height; y++) {
    const r0 = 2 * y * p.width
    const r1 = Math.min(2 * y + 1, p.height - 1) * p.width
    for (let x = 0; x < width; x++) {
      const c0 = 2 * x
      const c1 = Math.min(2 * x + 1, p.width - 1)
      out[y * width + x] = 0.25 * (d[r0 + c0]! + d[r0 + c1]! + d[r1 + c0]! + d[r1 + c1]!)
    }
  }
  return { width, height, data: out }
}

/** Level 0 is `base`; level k is half of level k-1. */
export const pyramid = (base: Plane, levels: number): ReadonlyArray<Plane> => {
  const out = [base]
  for (let k = 1; k < levels; k++) out.push(halve(out[k - 1]!))
  return out
}
