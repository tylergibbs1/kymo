import type { Track } from "@kymo/core"
import type { FrameRange } from "./Range.ts"
import { knownSamples } from "./Segment.ts"

/**
 * How exact a track's values are. `source` values are exact (ground truth, telemetry); `measured`
 * ones carry noise of about `noise` in the track's unit (a tracker's sub-pixel jitter).
 */
export type Precision = { readonly _tag: "source" } | { readonly _tag: "measured"; readonly noise: number }

/** A reversal smaller than this fraction of the track's span is not a turning point. */
const REVERSAL = 0.005
/** A value within this fraction of its travel from the final value has settled (as a spring does). */
const SETTLED = 0.001
/** Interior holds shorter than this many frames are not keyframed. */
const MIN_HOLD = 3

/**
 * The frames that describe a track's motion, as indices into the range: the first and last known
 * frames, the last frame of the starting rest (where it starts moving), the first frame of the final
 * rest (where it stops), both ends of any hold, and every local extreme, each at its exact frame
 * (the first frame of a flat extreme).
 */
export const keyframeIndices = (track: Track, range: FrameRange, precision: Precision): Array<number> => {
  const known = knownSamples(track, range)
  const n = known.length
  if (n === 0) return []
  const v = known.map(([, value]) => value)
  const span = Math.max(...v) - Math.min(...v)
  const noise = precision._tag === "measured" ? precision.noise : 0
  const exact = precision._tag === "measured" ? noise : 1e-9 * span
  const reverse = Math.max(REVERSAL * span, noise)
  const keys = new Set([0, n - 1])

  let a = 0
  while (a + 1 < n && Math.abs(v[a + 1]! - v[0]!) <= exact) a++
  const restFrom = (holds: (k: number) => boolean) => {
    let b = n - 1
    while (b - 1 >= 0 && holds(b - 1)) b--
    return b
  }
  const end = v[n - 1]!
  const exactRest = restFrom((k) => Math.abs(v[k]! - end) <= exact)
  const settle = SETTLED * (Math.abs(end - v[0]!) || span)
  const b =
    exactRest <= n - 2 || precision._tag === "measured"
      ? exactRest
      : restFrom((k) => Math.abs(v[k]! - end) < settle)
  if (b <= a) return [...keys].sort((x, y) => x - y).map((k) => known[k]![0])
  keys.add(a)
  keys.add(b)

  let dir = 0
  let ext = a
  for (let k = a + 1; k <= b; k++) {
    if (dir === 0) {
      if (Math.abs(v[k]! - v[a]!) > reverse) {
        dir = Math.sign(v[k]! - v[a]!)
        ext = k
      }
    } else if (dir * (v[k]! - v[ext]!) > 0) ext = k
    else if (dir * (v[ext]! - v[k]!) > reverse) {
      keys.add(ext)
      dir = -dir
      ext = k
    }
  }

  for (let k = a + 1; k < b; k++) {
    let h = k
    while (h + 1 < b && Math.abs(v[h + 1]! - v[k]!) <= exact) h++
    if (h - k + 1 >= MIN_HOLD) {
      keys.add(k)
      keys.add(h)
    }
    k = h
  }
  return [...keys].sort((x, y) => x - y).map((k) => known[k]![0])
}
