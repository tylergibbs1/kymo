import type { Track } from "@kymo/core"
import type { FrameRange } from "./Range.ts"

/** Inclusive frame indices where a track moves from one resting value to another. */
export interface Segment {
  readonly from: number
  readonly to: number
}

/** A value within this fraction of the track's span counts as resting. */
const REST = 0.005

/** Known samples of `track` inside `range`, as [index, value] pairs. */
export const knownSamples = (track: Track, range: FrameRange): Array<readonly [number, number]> => {
  const out: Array<readonly [number, number]> = []
  for (let i = range.first; i <= range.last; i++) {
    const v = track.samples[i]
    if (v !== null && v !== undefined) out.push([i, v])
  }
  return out
}

/**
 * Where the value leaves its starting rest and arrives at its final rest.
 * The ends are widened while the value keeps stepping the same way, so slow
 * ease-in/out tails are kept. Undefined when the track never moves.
 */
export const movingSegment = (samples: ReadonlyArray<readonly [number, number]>): Segment | undefined => {
  if (samples.length < 2) return undefined
  const values = samples.map(([, v]) => v)
  const span = Math.max(...values) - Math.min(...values)
  if (span === 0) return undefined
  const tol = REST * span
  const v0 = values[0]!
  const v1 = values[values.length - 1]!
  let a = 0
  while (a + 1 < values.length && Math.abs(values[a + 1]! - v0) <= tol) a++
  let b = values.length - 1
  while (b - 1 > a && Math.abs(values[b - 1]! - v1) <= tol) b--
  const dir = Math.sign(v1 - v0) || Math.sign(values[a + 1]! - values[a]!)
  const tiny = 1e-6 * span
  const step = (k: number) => values[k]! - values[k - 1]!
  while (a > 0 && Math.sign(step(a)) === dir && Math.abs(step(a)) > tiny) a--
  while (b < values.length - 1 && Math.sign(step(b + 1)) === dir && Math.abs(step(b + 1)) > tiny) b++
  return { from: samples[a]![0], to: samples[b]![0] }
}
