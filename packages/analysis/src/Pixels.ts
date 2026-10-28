import type { RgbImage } from "@kymo/core"

/** A single-channel 8-bit image (BT.601 luma). */
export interface Gray {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

export const HISTOGRAM_BINS = 32

export const toGray = (image: RgbImage): Gray => {
  const n = image.width * image.height
  const out = new Uint8Array(n)
  const src = image.data
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    out[p] = (src[i]! * 299 + src[i + 1]! * 587 + src[i + 2]! * 114 + 500) / 1000
  }
  return { width: image.width, height: image.height, data: out }
}

/** Mean luma, 0..1. */
export const meanLuma = (g: Gray): number => {
  let sum = 0
  for (const v of g.data) sum += v
  return sum / (g.data.length * 255)
}

/** Luma histogram normalised to sum to 1. */
export const histogram = (g: Gray): Float32Array => {
  const h = new Float32Array(HISTOGRAM_BINS)
  const shift = 8 - Math.log2(HISTOGRAM_BINS)
  for (const v of g.data) h[v >> shift]! += 1
  for (let b = 0; b < HISTOGRAM_BINS; b++) h[b]! /= g.data.length
  return h
}

/** Half the L1 distance between two normalised histograms: 0 identical, 1 disjoint. */
export const histogramDistance = (a: Float32Array, b: Float32Array): number => {
  let d = 0
  for (let i = 0; i < HISTOGRAM_BINS; i++) d += Math.abs(a[i]! - b[i]!)
  return d / 2
}

/** Mean absolute pixel difference, 0..1. Both images come from one source, so sizes match. */
export const meanAbsDiff = (a: Gray, b: Gray): number => {
  let sum = 0
  const x = a.data
  const y = b.data
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i]! - y[i]!)
  return sum / (x.length * 255)
}

/** How many pixels changed by each amount: `levels[d]` counts pixels whose luma moved by exactly `d`. */
export type DiffLevels = Uint32Array

/** Per-pixel absolute luma difference, counted by size (0..255). Both images come from one source. */
export const diffLevels = (a: Gray, b: Gray): DiffLevels => {
  const levels = new Uint32Array(256)
  const x = a.data
  const y = b.data
  for (let i = 0; i < x.length; i++) levels[Math.abs(x[i]! - y[i]!)]! += 1
  return levels
}

/** Mean absolute difference, 0..1, from counted levels: equal to `meanAbsDiff` of the same pair. */
export const levelsMean = (levels: DiffLevels): number => {
  let sum = 0
  let n = 0
  for (let d = 0; d < 256; d++) {
    sum += d * levels[d]!
    n += levels[d]!
  }
  return n === 0 ? 0 : sum / (n * 255)
}

/** Fraction of pixels that changed by more than `level` luma steps, 0..1. */
export const levelsAbove = (levels: DiffLevels, level: number): number => {
  let above = 0
  let n = 0
  for (let d = 0; d < 256; d++) {
    n += levels[d]!
    if (d > level) above += levels[d]!
  }
  return n === 0 ? 0 : above / n
}

/** Long edge of a thumbnail: small enough to keep one per frame, big enough to tell two shots apart. */
export const THUMB_EDGE = 16

/** `g` box-averaged so its long edge is at most `THUMB_EDGE`: motion blurs away, the shot remains. */
export const thumbnail = (g: Gray): Gray => {
  const scale = Math.max(1, Math.max(g.width, g.height) / THUMB_EDGE)
  const width = Math.max(1, Math.round(g.width / scale))
  const height = Math.max(1, Math.round(g.height / scale))
  const sums = new Float64Array(width * height)
  const counts = new Float64Array(width * height)
  for (let y = 0; y < g.height; y++) {
    const row = Math.min(height - 1, Math.floor((y * height) / g.height)) * width
    for (let x = 0; x < g.width; x++) {
      const t = row + Math.min(width - 1, Math.floor((x * width) / g.width))
      sums[t]! += g.data[y * g.width + x]!
      counts[t]! += 1
    }
  }
  const data = new Uint8Array(width * height)
  for (let t = 0; t < data.length; t++) data[t] = Math.round(sums[t]! / counts[t]!)
  return { width, height, data }
}
