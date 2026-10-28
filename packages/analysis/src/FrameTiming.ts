import { Address, fpsOf } from "@kymo/core"
import { type Cadence, cadences } from "./Cadence.ts"
import type { Cuts } from "./Cuts.ts"
import { type Finding, finding } from "./Finding.ts"
import type { FrameRange } from "./Range.ts"
import type { Scan } from "./Scan.ts"
import { maxHeldFrames, signals } from "./Signals.ts"
import { median } from "./Stats.ts"

/** What the pixel rules read: one scan and the cuts found in it. */
export interface PixelInput {
  readonly scan: Scan
  readonly cuts: Cuts
}

/** Mean luma below this is black: repeated black frames are black-frames' finding. */
export const BLACK = 0.03
/** Neighbours on each side whose motion must be steady for a skipped frame to show. */
const STEADY_RADIUS = 3
/** Steady: the busiest neighbour moves at most this much more than the quietest. */
const STEADY_SPREAD = 1.35
/** Two steps of motion must look this much bigger than one, or a skipped step cannot be seen. */
const MIN_TWO_STEP = 1.2
/**
 * A skipped frame makes one step look like two. On the log scale between one step and two, the
 * frame must sit at least this far towards two.
 */
const TOWARDS_TWO = 0.75
/** ...and no further than this beyond two steps (a bigger jump is a cut or a glitch, not one skip). */
const MAX_OVER_TWO = 1.5
/**
 * One step of motion must be this many times the clip's repeat noise to tell a skip from noise: on a
 * heavily compressed clip, a frame refreshed by the encoder jumps like a skip but moves nothing.
 */
const NOISE_MARGIN = 2

/** Scan positions inside a transition: `hard` is the new frame of each hard cut, `any` adds every fade frame. */
const transitions = ({ scan, cuts }: PixelInput) => {
  const first = scan.range.first
  const hard = new Set<number>()
  const any = new Set<number>()
  for (const c of cuts.cuts) {
    for (let i = c.from.index + 1; i <= c.to.index; i++) {
      any.add(i - first)
      if (c.kind === "hard") hard.add(i - first)
    }
  }
  return { hard, any }
}

export const runs = (flags: ReadonlyArray<boolean>): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  let start = -1
  flags.forEach((f, k) => {
    if (f && start < 0) start = k
    if (!f && start >= 0) {
      out.push([start, k - 1])
      start = -1
    }
  })
  if (start >= 0) out.push([start, flags.length - 1])
  return out
}

/** Longest regular cadence worth looking for: two seconds of frames, at least a dozen. */
const maxPeriod = (range: FrameRange) => Math.max(12, Math.round(2 * fpsOf(range.rate)))

const ordinal = (n: number) => (n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`)
const fpsText = (fps: number) => `${Number.isInteger(fps) ? fps : fps.toFixed(2)} fps`

/** One finding for a regular cadence of repeated or skipped frames. */
const cadenceFinding = (
  range: FrameRange,
  rule: "duplicate-frames" | "dropped-frames",
  c: Cadence
): Finding => {
  const fps = fpsOf(range.rate)
  const first = range.first + c.events[0]!
  const last = range.first + c.events[c.events.length - 1]!
  const where = `from ${Address.label(range.rate, first)} to ${Address.label(range.rate, last)}`
  const every =
    c.perPeriod === 1 ? `Every ${ordinal(c.period)} frame` : `${c.perPeriod} of every ${c.period} frames`
  const repeated = rule === "duplicate-frames"
  const source = repeated
    ? (fps * (c.period - c.perPeriod)) / c.period
    : (fps * (c.period + c.perPeriod)) / c.period
  // Repeats show every picture (pulldown is how 24 fps plays at 60); skips lose pictures, so they judder.
  return finding(range, {
    rule,
    severity: repeated ? "info" : "warning",
    index: first,
    last,
    message: `${every} ${repeated ? "repeats the frame before" : "is skipped"} ${where} (${c.events.length} frames): a regular cadence, as from a frame-rate conversion from ${fpsText(source)} to ${fpsText(fps)}${repeated && c.perPeriod === 1 && c.period === 2 ? " or animation held on twos" : ""}.`,
    view: "diff"
  })
}

/**
 * Frames that repeat the one before while the picture moves on both sides: held or duplicated frames.
 * A regular cadence of them (a frame-rate conversion) is one info finding, not one warning per frame.
 */
export const duplicateFrames = (input: PixelInput): Array<Finding> => {
  const { range, frames } = input.scan
  const sig = signals(input.scan)
  const { hard } = transitions(input)
  const maxHeld = maxHeldFrames(input.scan)
  // A frame in a fade is still moving; only a hard cut's frame says nothing about motion.
  const moving = (k: number) => sig.moving[k] === true && !hard.has(k)
  const held = runs(sig.repeat.map((r, k) => r && !hard.has(k) && frames[k]!.luma >= BLACK)).filter(
    ([a, b]) => b - a + 1 <= maxHeld && moving(a - 1) && moving(b + 1)
  )
  const isEvent = frames.map(() => false)
  for (const [a, b] of held) for (let k = a; k <= b; k++) isEvent[k] = true
  const regular = cadences(
    isEvent,
    frames.map((_, k) => isEvent[k]! || moving(k)),
    maxPeriod(range)
  )
  const inCadence = new Set(regular.flatMap((c) => c.events))
  const irregular = held
    .filter(([a]) => !inCadence.has(a))
    .map(([a, b]) => {
      const first = range.first + a
      const count = b - a + 1
      return finding(range, {
        rule: "duplicate-frames",
        severity: "warning",
        index: first,
        last: range.first + b,
        message:
          count === 1
            ? `${Address.label(range.rate, first)} repeats the frame before it while the picture is moving: a held or duplicated frame.`
            : `${count} frames from ${Address.label(range.rate, first)} repeat the frame before them while the picture is moving.`,
        view: "diff"
      })
    })
  return [...irregular, ...regular.map((c) => cadenceFinding(range, "duplicate-frames", c))].sort(
    (a, b) => a.index - b.index
  )
}

/**
 * Frames whose step from the one before looks like two steps of the steady motion around them: a frame
 * between them was skipped. Two steps are measured, not assumed to be twice one (on textured footage the
 * difference saturates), so the test calibrates itself to the clip. Transitions are not motion.
 */
export const droppedFrames = (input: PixelInput): Array<Finding> => {
  const { range, frames } = input.scan
  const sig = signals(input.scan)
  const { any } = transitions(input)
  const one = (k: number) => frames[k]?.motion ?? null
  const two = (k: number) => frames[k]?.motion2 ?? null
  const testable = frames.map(() => false)
  const isEvent = frames.map(() => false)
  const ratios = new Map<number, number>()
  for (let k = 0; k < frames.length; k++) {
    const v = one(k)
    const around = [-3, -2, -1, 1, 2, 3].map((d) => k + d)
    if (v === null || [k, ...around].some((j) => any.has(j))) continue
    if (around.some((j) => !sig.moving[j])) continue
    const steady = around.map(one).filter((x): x is number => x !== null)
    if (steady.length < 2 * STEADY_RADIUS) continue
    const lo = Math.min(...steady)
    if (Math.max(...steady) > STEADY_SPREAD * lo || lo <= 0) continue
    const step = median(steady)
    // Two-step differences that do not straddle k: (k-3, k-1), (k-4, k-2), (k, k+2), (k+1, k+3).
    const twos = [k - 1, k - 2, k + 2, k + 3].map(two).filter((x): x is number => x !== null)
    if (twos.length < 4) continue
    const twoSteps = median(twos)
    if (twoSteps < MIN_TWO_STEP * step || step < NOISE_MARGIN * sig.repeatNoise) continue
    testable[k] = true
    if (v < step * (twoSteps / step) ** TOWARDS_TWO || v > MAX_OVER_TWO * twoSteps) continue
    isEvent[k] = true
    ratios.set(k, v / step)
  }
  const regular = cadences(isEvent, testable, maxPeriod(range))
  const inCadence = new Set(regular.flatMap((c) => c.events))
  const irregular = [...ratios]
    .filter(([k]) => !inCadence.has(k))
    .map(([k, ratio]) => {
      const i = range.first + k
      return finding(range, {
        rule: "dropped-frames",
        severity: "warning",
        index: i,
        message: `Motion into ${Address.label(range.rate, i)} is ${ratio.toFixed(1)}x its steady neighbours, as big as two steps of their motion: a frame between ${Address.format(range.rate, i - 1)} and ${Address.format(range.rate, i)} looks dropped.`,
        view: "diff"
      })
    })
  return [...irregular, ...regular.map((c) => cadenceFinding(range, "dropped-frames", c))].sort(
    (a, b) => a.index - b.index
  )
}
