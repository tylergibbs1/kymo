import { fpsOf } from "@kymo/core"
import { type DiffLevels, levelsAbove } from "./Pixels.ts"
import type { Scan } from "./Scan.ts"
import { median } from "./Stats.ts"

/**
 * What moved, measured against this clip's own noise instead of the whole frame. A small element moving
 * in a large still frame barely shifts the frame's mean difference, but its edge pixels change by far
 * more than the encoder's noise. Rules and sampling read these, never fractions of the whole frame.
 */
export interface Signals {
  /** Luma steps (0..255) a pixel must change by to count as changed: this clip's noise. */
  readonly noiseLevel: number
  /** Per scan position: fraction of pixels that changed by more than `noiseLevel`; null for the first frame. */
  readonly changed: ReadonlyArray<number | null>
  /** Per scan position: did anything visibly move since the previous frame? */
  readonly moving: ReadonlyArray<boolean>
  /** Per scan position: much quieter than the frames around it, i.e. a repeat of the frame before. */
  readonly repeat: ReadonlyArray<boolean>
  /** Mean difference (0..1) a repeated frame of this clip typically shows: its encoder noise. 0 if none repeat. */
  readonly repeatNoise: number
}

/** Below this many luma steps a change is rounding or dither, whatever the clip. */
const MIN_NOISE_LEVEL = 2
/** This many changed pixels is movement: a short edge, not one stray pixel. */
const MIN_MOVING_PIXELS = 3
/** Noise is what the quietest pairs show: this share of pixels in them changes by no more than it. */
const NOISE_QUANTILE = 0.99
const QUIET_SHARE = 0.1
/** A repeated frame changes at most this share of what the frames on either side of it change. */
export const REPEAT_RATIO = 0.25

const total = (levels: DiffLevels): number => {
  let n = 0
  for (let d = 0; d < 256; d++) n += levels[d]!
  return n
}

/** The luma step that a share `q` of the pixels' changes do not exceed. */
const levelQuantile = (levels: DiffLevels, q: number): number => {
  const n = total(levels)
  let seen = 0
  for (let d = 0; d < 256; d++) {
    seen += levels[d]!
    if (seen >= q * n) return d
  }
  return 255
}

/** A repeat is always at least this much quieter than the motion into and out of it. */
const QUIET_RATIO = 0.5
/** A frame within this multiple of the clip's typical repeat noise is a repeat, if it is quiet. */
const NOISE_MARGIN = 1.5
/** Repeat noise is estimated from this many confident repeats or more. */
const MIN_NOISE_SAMPLES = 3

/** Typical motion around a frame: the upper quartile over this many frames each side. */
const TYPICAL_RADIUS = 6
const TYPICAL_QUANTILE = 0.75

/**
 * The motion typical around each frame. An upper quartile, so it ignores both a one-frame spike (a
 * jump, a flash) and the repeats themselves, which can be most frames in a frame-rate conversion.
 */
const typicalMotion = (motion: ReadonlyArray<number | null>): Array<number> =>
  motion.map((_, k) => {
    const near = motion
      .slice(Math.max(0, k - TYPICAL_RADIUS), k + TYPICAL_RADIUS + 1)
      .filter((m): m is number => m !== null)
      .sort((a, b) => a - b)
    return near[Math.floor(TYPICAL_QUANTILE * (near.length - 1))] ?? 0
  })

/** Motion slowing by at least this factor per frame into a quiet run, and speeding up out of it, is a turnaround. */
const TURN = 1.15

/**
 * A quiet run at the bottom of a V: motion slows into it and speeds up out of it, as when a bounce or
 * a spring reverses. The picture barely moves there because the velocity crosses zero, not because a
 * frame was held; a held frame interrupts motion that is steady on both sides. Two frames out on each
 * side, so motion snapped to whole pixels (steps 2, 1, 1, 0) still reads as slowing.
 */
const turnaround = (motion: ReadonlyArray<number | null>, a: number, b: number): boolean => {
  const at = (k: number) => motion[k] ?? 0
  const into = at(a - 1)
  const out = at(b + 1)
  return (
    into > 0 &&
    out > 0 &&
    Math.max(at(a - 2), at(a - 3)) >= TURN * into &&
    Math.max(at(b + 2), at(b + 3)) >= TURN * out
  )
}

/**
 * Runs of frames much quieter than the motion into and out of them and the motion typical around
 * them: each repeats the frame before. Quiet means at most `REPEAT_RATIO` of that motion, or within
 * the clip's own repeat noise.
 */
const repeatRuns = (
  motion: ReadonlyArray<number | null>,
  typical: ReadonlyArray<number>,
  noise: number
): Array<readonly [number, number]> => {
  const out: Array<readonly [number, number]> = []
  const quiet = (m: number | null | undefined, into: number): m is number =>
    m !== null && m !== undefined && m <= Math.max(REPEAT_RATIO * into, noise)
  for (let a = 1; a < motion.length; a++) {
    const into = motion[a - 1]
    if (into === null || into === undefined || into <= 0 || !quiet(motion[a], into)) continue
    let b = a
    while (quiet(motion[b + 1], into)) b++
    const after = motion[b + 1]
    let peak = 0
    for (let k = a; k <= b; k++) peak = Math.max(peak, motion[k]!)
    const around = Math.min(into, after ?? 0, typical[a]!, typical[b]!)
    const quietRun = peak <= Math.max(REPEAT_RATIO * around, Math.min(noise, QUIET_RATIO * around))
    if (quietRun && !turnaround(motion, a, b)) out.push([a, b])
    a = b
  }
  return out
}

/**
 * Repeated frames. Encoder noise makes a repeat differ a little from the frame before, and more so in
 * motion than in a still scene, so the clip's own held frames (short repeats, not pauses) set the
 * noise: confident repeats first, then anything as quiet as they are.
 */
const repeats = (
  motion: ReadonlyArray<number | null>,
  maxHeld: number
): { repeat: Array<boolean>; noise: number } => {
  const typical = typicalMotion(motion)
  const held = repeatRuns(motion, typical, 0).filter(([a, b]) => b - a + 1 <= maxHeld)
  const noisy = held.flatMap(([a, b]) => motion.slice(a, b + 1) as Array<number>)
  const noise = noisy.length >= MIN_NOISE_SAMPLES ? median(noisy) : 0
  const repeat = motion.map(() => false)
  for (const [a, b] of repeatRuns(motion, typical, NOISE_MARGIN * noise))
    for (let k = a; k <= b; k++) repeat[k] = true
  return { repeat, noise }
}

/** Longest repeat, in seconds, that counts as a held or stalled frame; anything longer is a pause. */
export const MAX_HELD_SECONDS = 0.25

/** The longest held frame, in frames, at this scan's rate. */
export const maxHeldFrames = (scan: Scan): number =>
  Math.max(1, Math.round(MAX_HELD_SECONDS * fpsOf(scan.range.rate)))

/** Clip-relative motion signals for a scan. Pure and cheap: reads only the scan's counted differences. */
export const signals = (scan: Scan): Signals => {
  const f = scan.frames
  const { repeat, noise: repeatNoise } = repeats(
    f.map((s) => s.motion),
    maxHeldFrames(scan)
  )
  // The quietest pairs that are not repeats: a still shot's grain, or the slowest motion in the clip.
  const levels = f.flatMap((s, k) =>
    s.levels === null || repeat[k] ? [] : [levelQuantile(s.levels, NOISE_QUANTILE)]
  )
  levels.sort((a, b) => a - b)
  const noiseLevel = Math.max(MIN_NOISE_LEVEL, levels[Math.floor(QUIET_SHARE * (levels.length - 1))] ?? 0)
  const changed = f.map((s) => (s.levels === null ? null : levelsAbove(s.levels, noiseLevel)))
  const moving = f.map(
    (s, k) => s.levels !== null && changed[k]! * total(s.levels) >= MIN_MOVING_PIXELS && !repeat[k]
  )
  return { noiseLevel, changed, moving, repeat, repeatNoise }
}
