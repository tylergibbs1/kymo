import { FrameRef, Marker, Track, fpsOf } from "@kymo/core"
import { Schema } from "effect"
import type { Cuts } from "./Cuts.ts"
import type { Scan } from "./Scan.ts"
import { mean, round, std } from "./Stats.ts"

export const MOTION_TRACK = "motion"

export const MotionPeak = Schema.Struct({ marker: Marker, value: Schema.Number })
export type MotionPeak = typeof MotionPeak.Type

export const MotionWindow = Schema.Struct({
  from: FrameRef,
  to: FrameRef,
  /** The window as a range address, e.g. `01s..02s`. */
  address: Schema.String,
  /** Mean motion energy over the window, 0..1. */
  mean: Schema.Number
})
export type MotionWindow = typeof MotionWindow.Type

export const Motion = Schema.Struct({
  /** `motion`: mean absolute luma difference from the previous frame, 0..1. Null outside the range. */
  track: Track,
  mean: Schema.Number,
  max: Schema.Number,
  maxAt: FrameRef,
  /** Fraction of frames whose energy is below the stillness floor. */
  stillRatio: Schema.Number,
  /** Strongest first: `peak1` is the biggest motion peak. Cut frames are not peaks. */
  peaks: Schema.Array(MotionPeak),
  /** The busiest non-overlapping windows (about one second each), busiest first. */
  windows: Schema.Array(MotionWindow)
})
export type Motion = typeof Motion.Type

export const STILL_FLOOR = 0.002
const MAX_PEAKS = 5
const MAX_WINDOWS = 3

/** Per-frame energy over the scan, with cut transitions zeroed: a cut is a change of shot, not motion. */
export const shotEnergy = (scan: Scan, cuts: Cuts): Array<number> => {
  const first = scan.range.first
  const energy = scan.frames.map((f) => f.motion ?? 0)
  for (const c of cuts.cuts) {
    for (let i = c.from.index + 1; i <= c.to.index; i++) {
      if (i - first >= 0 && i - first < energy.length) energy[i - first] = 0
    }
  }
  return energy
}

const findPeaks = (energy: ReadonlyArray<number>, separation: number): Array<number> => {
  const floor = Math.max(STILL_FLOOR, mean(energy) + std(energy))
  const candidates: Array<number> = []
  for (let k = 0; k < energy.length; k++) {
    const v = energy[k]!
    if (v <= floor) continue
    let isMax = true
    for (let j = Math.max(0, k - separation); j <= Math.min(energy.length - 1, k + separation); j++) {
      // Ties go to the earliest frame, so a plateau yields one peak.
      if (energy[j]! > v || (energy[j]! === v && j < k)) isMax = false
    }
    if (isMax) candidates.push(k)
  }
  return candidates.sort((a, b) => energy[b]! - energy[a]! || a - b).slice(0, MAX_PEAKS)
}

const busiestWindows = (energy: ReadonlyArray<number>, length: number): Array<[number, number]> => {
  const sums: Array<number> = []
  let running = 0
  for (let k = 0; k < energy.length; k++) {
    running += energy[k]!
    if (k >= length) running -= energy[k - length]!
    if (k >= length - 1) sums.push(running)
  }
  const order = sums.map((_, k) => k).sort((a, b) => sums[b]! - sums[a]! || a - b)
  const chosen: Array<[number, number]> = []
  for (const start of order) {
    if (chosen.length === MAX_WINDOWS || sums[start]! <= 0) break
    const end = start + length - 1
    if (chosen.every(([a, b]) => end < a || start > b)) chosen.push([start, end])
  }
  return chosen
}

/** Motion energy as a Track plus a summary. Pure: reuses the scan's numbers. */
export const motionEnergy = (scan: Scan, cuts: Cuts): Motion => {
  const { range } = scan
  const fps = fpsOf(range.rate)
  const samples: Array<number | null> = Array.from({ length: range.frameCount }, () => null)
  for (const f of scan.frames) samples[f.index] = f.motion === null ? null : round(f.motion, 6)
  const energy = shotEnergy(scan, cuts)
  const known = scan.frames.flatMap((f) => (f.motion === null ? [] : [f.motion]))
  let maxK = 0
  energy.forEach((v, k) => {
    if (v > energy[maxK]!) maxK = k
  })
  const peaks = findPeaks(energy, Math.max(2, Math.round(fps / 4)))
  const windowLength = Math.max(1, Math.min(energy.length, Math.round(fps)))
  return {
    track: { name: MOTION_TRACK, unit: "0..1", samples },
    mean: round(mean(known), 6),
    max: round(energy[maxK]!, 6),
    maxAt: range.ref(range.first + maxK),
    stillRatio: round(known.filter((v) => v < STILL_FLOOR).length / Math.max(1, known.length)),
    peaks: peaks.map((k, i) => {
      const ref = range.ref(range.first + k)
      return {
        marker: { name: `peak${i + 1}`, index: ref.index, address: ref.address, origin: "peak" },
        value: round(energy[k]!, 6)
      }
    }),
    windows: busiestWindows(energy, windowLength).map(([a, b]) => ({
      from: range.ref(range.first + a),
      to: range.ref(range.first + b),
      address: range.spanText(range.first + a, range.first + b),
      mean: round(mean(energy.slice(a, b + 1)), 6)
    }))
  }
}
