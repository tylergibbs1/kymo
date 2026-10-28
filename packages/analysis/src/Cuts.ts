import { FrameRef, Marker } from "@kymo/core"
import { Schema } from "effect"
import { histogramDistance } from "./Pixels.ts"
import type { Scan } from "./Scan.ts"
import { median, neighbours, robustSigma, round } from "./Stats.ts"

export const Cut = Schema.Struct({
  kind: Schema.Literals(["hard", "fade"]),
  /** `cutN` at the first frame of the new shot (hard) or the middle of the fade. */
  marker: Marker,
  /** Last frame of the outgoing shot. */
  from: FrameRef,
  /** First frame fully in the incoming shot. */
  to: FrameRef,
  /** First frame where the incoming shot is visible: the new frame of a hard cut, the first mixed frame of a fade. */
  incoming: FrameRef,
  /** Histogram distance across the transition, 0..1. */
  score: Schema.Number
})
export type Cut = typeof Cut.Type

export const Cuts = Schema.Struct({ cuts: Schema.Array(Cut) })
export type Cuts = typeof Cuts.Type

/** A hard cut changes the histogram by at least this much, whatever the local baseline. */
const HARD_FLOOR = 0.2
/** ...and moves pixels by at least this much. */
const MOTION_FLOOR = 0.03
/** ...and stands this many robust sigmas above its neighbourhood. */
const SIGMAS = 6
const BASELINE_RADIUS = 12
/** A fade is a steady luma ramp at least this long whose ends differ this much. */
const FADE_MIN_FRAMES = 4
const FADE_MIN_STEP = 0.004
const FADE_MIN_LUMA = 0.15
const FADE_MIN_HIST = 0.3

interface Found {
  readonly kind: Cut["kind"]
  readonly at: number
  readonly from: number
  readonly to: number
  readonly score: number
}

const hardCuts = (scan: Scan): Array<Found> => {
  const f = scan.frames
  const diffs = f.map((s) => s.histDiff ?? 0)
  const out: Array<Found> = []
  for (let k = 0; k < f.length; k++) {
    const s = f[k]!
    if (s.histDiff === null || s.motion === null) continue
    const around = neighbours(diffs, k, BASELINE_RADIUS)
    const threshold = Math.max(HARD_FLOOR, median(around) + SIGMAS * robustSigma(around), 3 * median(around))
    if (s.histDiff < threshold || s.motion < MOTION_FLOOR) continue
    if (neighbours(diffs, k, 2).some((d) => d > s.histDiff!)) continue
    // A cut persists; a one-frame flash returns. Compare the frame before with the frame after.
    const after = f[k + 1]
    const before = f[k - 1]
    if (after && before && histogramDistance(before.histogram, after.histogram) < s.histDiff / 2) continue
    // ...and the frame after a flash looks like the one before it.
    const twoBack = f[k - 2]
    if (twoBack && histogramDistance(twoBack.histogram, s.histogram) < s.histDiff / 2) continue
    out.push({ kind: "hard", at: s.index, from: s.index - 1, to: s.index, score: s.histDiff })
  }
  return out
}

const fades = (scan: Scan): Array<Found> => {
  const f = scan.frames
  const out: Array<Found> = []
  let start = 1
  let sign = 0
  const flush = (end: number) => {
    // Frames start..end-1 each stepped luma the same way; the ramp runs from start-1 to end-1.
    const a = f[start - 1]
    const b = f[end - 1]
    if (sign === 0 || !a || !b || end - start < FADE_MIN_FRAMES) return
    const score = histogramDistance(a.histogram, b.histogram)
    if (Math.abs(b.luma - a.luma) < FADE_MIN_LUMA || score < FADE_MIN_HIST) return
    out.push({ kind: "fade", at: Math.round((a.index + b.index) / 2), from: a.index, to: b.index, score })
  }
  for (let k = 1; k < f.length; k++) {
    const step = f[k]!.luma - f[k - 1]!.luma
    const s = Math.abs(step) >= FADE_MIN_STEP ? Math.sign(step) : 0
    if (s === 0 || s !== sign) {
      flush(k)
      start = k
      sign = s
    }
  }
  flush(f.length)
  return out
}

/**
 * Hard cuts (an adaptive histogram threshold plus a pixel-motion floor, ignoring
 * one-frame flashes) and fades (a steady luma ramp between two different shots).
 * Markers are `cut1..` in time order.
 */
export const detectCuts = (scan: Scan): Cuts => {
  const found = fades(scan)
  for (const h of hardCuts(scan)) {
    if (!found.some((x) => h.at >= x.from && h.at <= x.to)) found.push(h)
  }
  found.sort((a, b) => a.at - b.at)
  const { range } = scan
  return {
    cuts: found.map((x, i) => {
      const ref = range.ref(x.at)
      return {
        kind: x.kind,
        marker: { name: `cut${i + 1}`, index: ref.index, address: ref.address, origin: "cut" },
        from: range.ref(x.from),
        to: range.ref(x.to),
        // Every transition starts on the frame after the outgoing shot's last one.
        incoming: range.ref(x.from + 1),
        score: round(x.score)
      }
    })
  }
}
