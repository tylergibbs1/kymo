import { FrameRef, Marker, fpsOf } from "@kymo/core"
import { Schema } from "effect"
import { type Gray, histogramDistance, meanAbsDiff } from "./Pixels.ts"
import type { Scan } from "./Scan.ts"
import { signals } from "./Signals.ts"
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
/** ...and stands this many robust sigmas above its neighbourhood. */
const SIGMAS = 6
const BASELINE_RADIUS = 12
/**
 * ...and changes the coarse picture (the thumbnail) more than this multiple of what nine in ten of the
 * clip's own changes do. Relative, so a title card in a dark screen recording counts as much as a cut
 * between two film shots, and text streaming into a page does not.
 */
const COARSE_QUANTILE = 0.9
const COARSE_MARGIN = 1.25
/** A fade mixes at least this many frames. */
const FADE_MIN_FRAMES = 3
/** A fade lasts at most this long. */
const FADE_MAX_SECONDS = 2
/** In a fade every frame is a mix of the two ends: what the mix leaves unexplained is at most this share of the change. */
const MIX_RESIDUAL = 0.25
/** The mix moves one way; noise may step it back this much. */
const MIX_BACKSTEP = 0.15
/** No single frame carries more than this share of a fade (that would be a hard cut inside it). */
const MIX_MAX_STEP = 0.5
/** Mixes this close to an end count as that end. */
const MIX_END = 0.05
/**
 * A fade changes the tones (the histogram) between its ends or through its middle, where two pictures
 * superimposed flatten the contrast, by this multiple of what one frame of this clip usually does, within
 * these bounds. Motion moves the picture without changing its tones.
 */
const TONE_MARGIN = 4
const TONE_MIN = 0.1

interface Found {
  readonly kind: Cut["kind"]
  readonly at: number
  readonly from: number
  readonly to: number
  readonly score: number
}

/** How much the coarse picture changed from the frame before, per scan position. */
const coarseChange = (scan: Scan): Array<number> =>
  scan.frames.map((f, k) => (k === 0 ? 0 : meanAbsDiff(scan.frames[k - 1]!.thumb, f.thumb)))

/** The coarse change a cut must exceed: well above what this clip's changes usually do. */
const coarseFloor = (coarse: ReadonlyArray<number>, moving: ReadonlyArray<boolean>): number => {
  const changes = coarse.filter((_, k) => moving[k]).sort((a, b) => a - b)
  return COARSE_MARGIN * (changes[Math.floor(COARSE_QUANTILE * (changes.length - 1))] ?? 0)
}

const hardCuts = (scan: Scan, coarse: ReadonlyArray<number>, floor: number): Array<Found> => {
  const f = scan.frames
  const diffs = f.map((s) => s.histDiff ?? 0)
  const out: Array<Found> = []
  for (let k = 0; k < f.length; k++) {
    const s = f[k]!
    if (s.histDiff === null) continue
    const around = neighbours(diffs, k, BASELINE_RADIUS)
    const threshold = Math.max(HARD_FLOOR, median(around) + SIGMAS * robustSigma(around), 3 * median(around))
    if (s.histDiff < threshold || coarse[k]! <= 0 || coarse[k]! < floor) continue
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

/** Where each frame of `a..b` sits between the two ends' thumbnails (0 at a, 1 at b), and how well. */
const mix = (thumbs: ReadonlyArray<Gray>, a: number, b: number) => {
  const ta = thumbs[a]!.data
  const tb = thumbs[b]!.data
  let span = 0
  for (let i = 0; i < ta.length; i++) span += (tb[i]! - ta[i]!) ** 2
  const alphas: Array<number> = []
  let residual = 0
  for (let k = a; k <= b; k++) {
    const t = thumbs[k]!.data
    let dot = 0
    for (let i = 0; i < ta.length; i++) dot += (t[i]! - ta[i]!) * (tb[i]! - ta[i]!)
    const alpha = span === 0 ? 0 : dot / span
    let r = 0
    for (let i = 0; i < ta.length; i++) r += Math.abs(t[i]! - (ta[i]! + alpha * (tb[i]! - ta[i]!)))
    residual += r / (ta.length * 255)
    alphas.push(alpha)
  }
  return { alphas, residual: residual / (b - a + 1) }
}

/**
 * The fade across `a..b`, if every frame is a mix of the two ends moving steadily from one to the
 * other. Its ends are trimmed to the last frame still all outgoing and the first frame all incoming.
 */
const fadeAcross = (
  thumbs: ReadonlyArray<Gray>,
  a: number,
  b: number
): { from: number; to: number } | undefined => {
  const change = meanAbsDiff(thumbs[a]!, thumbs[b]!)
  const { alphas, residual } = mix(thumbs, a, b)
  if (residual > MIX_RESIDUAL * change) return undefined
  let high = 0
  for (let j = 1; j < alphas.length; j++) {
    if (alphas[j]! < high - MIX_BACKSTEP || alphas[j]! - alphas[j - 1]! > MIX_MAX_STEP) return undefined
    high = Math.max(high, alphas[j]!)
  }
  let from = 0
  while (from + 1 < alphas.length && alphas[from + 1]! <= MIX_END) from++
  let to = alphas.length - 1
  while (to - 1 > from && alphas[to - 1]! >= 1 - MIX_END) to--
  return to - from - 1 >= FADE_MIN_FRAMES - 1 ? { from: a + from, to: a + to } : undefined
}

/**
 * Fades and dissolves: two frames some way apart show different pictures, and every frame between them
 * is a steady mix of the two. Found on thumbnails, so motion inside either shot blurs away, and repeated
 * frames (a frame-rate conversion) do not break the mix.
 */
const fades = (scan: Scan, floor: number): Array<Found> => {
  const f = scan.frames
  const hist = f.flatMap((s) => (s.histDiff === null ? [] : [s.histDiff])).sort((a, b) => a - b)
  const tone = Math.min(
    HARD_FLOOR,
    Math.max(TONE_MIN, TONE_MARGIN * (hist[Math.floor(COARSE_QUANTILE * (hist.length - 1))] ?? 0))
  )
  const toneChange = (from: number, to: number) => {
    const mid = f[Math.round((from + to) / 2)]!.histogram
    const [a, b] = [f[from]!.histogram, f[to]!.histogram]
    return Math.max(histogramDistance(a, b), histogramDistance(a, mid), histogramDistance(mid, b))
  }
  const thumbs = f.map((s) => s.thumb)
  const maxHalf = Math.max(FADE_MIN_FRAMES, Math.round((FADE_MAX_SECONDS * fpsOf(scan.range.rate)) / 2))
  const found: Array<{ from: number; to: number }> = []
  for (let half = 2; half <= maxHalf; half = Math.max(half + 1, Math.round(half * 1.5))) {
    const across = f.map((_, c) =>
      c - half < 0 || c + half >= f.length ? 0 : meanAbsDiff(thumbs[c - half]!, thumbs[c + half]!)
    )
    for (let c = half; c + half < f.length; c++) {
      // Different pictures at the ends: more than a cut's worth of change, and the most around here.
      if (across[c]! < floor || across[c]! <= 0) continue
      if (neighbours(across, c, half).some((x) => x > across[c]!)) continue
      const fade = fadeAcross(thumbs, c - half, c + half)
      // Two shots, not one shot moving: the tones change.
      if (fade && toneChange(fade.from, fade.to) >= tone) found.push(fade)
    }
  }
  // Overlapping windows found the same fade: keep their union. Fades that only touch (out to black,
  // then in from it) stay apart.
  found.sort((x, y) => x.from - y.from)
  const merged: Array<{ from: number; to: number }> = []
  for (const x of found) {
    const last = merged[merged.length - 1]
    if (last && x.from < last.to) merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, x.to) }
    else merged.push(x)
  }
  return merged.map(({ from, to }) => ({
    kind: "fade",
    at: f[Math.round((from + to) / 2)]!.index,
    from: f[from]!.index,
    to: f[to]!.index,
    score: histogramDistance(f[from]!.histogram, f[to]!.histogram)
  }))
}

/**
 * Hard cuts (an adaptive histogram threshold plus a coarse-picture change relative to the clip's own,
 * ignoring one-frame flashes) and fades or dissolves (every frame between two pictures is a steady mix of
 * them). Markers are `cut1..` in time order.
 */
export const detectCuts = (scan: Scan): Cuts => {
  const coarse = coarseChange(scan)
  const floor = coarseFloor(coarse, signals(scan).moving)
  const found = fades(scan, floor)
  for (const h of hardCuts(scan, coarse, floor)) {
    if (!found.some((x) => h.at > x.from && h.at <= x.to)) found.push(h)
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
