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
