import { Address, fpsOf } from "@kymo/core"
import { type Cadence, cadences } from "./Cadence.ts"
import type { Cuts } from "./Cuts.ts"
import { type Finding, finding } from "./Finding.ts"
import type { FrameRange } from "./Range.ts"
import type { Scan } from "./Scan.ts"
import { maxHeldFrames, signals } from "./Signals.ts"
import { median } from "./Stats.ts"

/** What the pixel rules read: one scan, the cuts found in it, and how messages label frames. */
export interface PixelInput {
  readonly scan: Scan
  readonly cuts: Cuts
  readonly labelStyle: Address.LabelStyle
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
  style: Address.LabelStyle,
  rule: "duplicate-frames" | "dropped-frames",
  c: Cadence
): Finding => {
  const fps = fpsOf(range.rate)
  const first = range.first + c.events[0]!
  const last = range.first + c.events[c.events.length - 1]!
  const label = (i: number) => Address.styledLabel(range.rate, i, style)
  const where = `from ${label(first)} to ${label(last)}`
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
  const label = (i: number) => Address.styledLabel(range.rate, i, input.labelStyle)
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
            ? `${label(first)} repeats the frame before it while the picture is moving: a held or duplicated frame.`
            : `${count} frames in a row, ${label(first)} to ${label(range.first + b)}, each repeats the frame before it while the picture is moving.`,
        view: "diff"
      })
    })
  return [
    ...irregular,
    ...regular.map((c) => cadenceFinding(range, input.labelStyle, "duplicate-frames", c))
  ].sort((a, b) => a.index - b.index)
}

/** Each side of a frame needs this many steadily moving neighbours, and both sides together `2 * STEADY_RADIUS - 1`. */
const MIN_SIDE = 2

/**
 * The steadily moving frames either side of `k`, nearest first: up to `STEADY_RADIUS` each side,
 * stopping where the picture stops moving or a transition begins. A hold right before `k` is stepped
 * over, so the frame after a hold is judged against the motion around the hold.
 */
const steadySides = (
  k: number,
  holdBefore: readonly [number, number] | undefined,
  isSteady: (j: number) => boolean
): { readonly before: Array<number>; readonly after: Array<number> } => {
  const side = (from: number, dir: 1 | -1) => {
    const out: Array<number> = []
    for (let j = from; out.length < STEADY_RADIUS && isSteady(j); j += dir) out.push(j)
    return out
  }
  return { before: side((holdBefore?.[0] ?? k) - 1, -1), after: side(k + 1, 1) }
}

/**
 * Frames whose step from the one before looks like two steps of the steady motion around them: a frame
 * between them was skipped. Two steps are measured, not assumed to be twice one (on textured footage the
 * difference saturates), so the test calibrates itself to the clip. Transitions are not motion.
 *
 * A frame that lands two steps on right after a held frame is a dropped frame too: the hold showed step
 * k-1 twice and the next frame shows step k+1, so step k was never shown.
 */
export const droppedFrames = (input: PixelInput): Array<Finding> => {
  const { range, frames } = input.scan
  const label = (i: number) => Address.styledLabel(range.rate, i, input.labelStyle)
  const address = (i: number) => Address.styledAddress(range.rate, i, input.labelStyle)
  const sig = signals(input.scan)
  const { any } = transitions(input)
  const maxHeld = maxHeldFrames(input.scan)
  const one = (k: number) => frames[k]?.motion ?? null
  const two = (k: number) => frames[k]?.motion2 ?? null
  const isSteady = (j: number) => sig.moving[j] === true && !any.has(j) && one(j) !== null
  const holdBefore = new Map<number, readonly [number, number]>()
  for (const [a, b] of runs(sig.repeat)) if (b - a + 1 <= maxHeld) holdBefore.set(b + 1, [a, b])
  const testable = frames.map(() => false)
  const isEvent = frames.map(() => false)
  const ratios = new Map<number, number>()
  for (let k = 0; k < frames.length; k++) {
    const v = one(k)
    if (v === null || any.has(k)) continue
    const hold = holdBefore.get(k)
    const { before, after } = steadySides(k, hold, isSteady)
    if (Math.min(before.length, after.length) < MIN_SIDE) continue
    if (before.length + after.length < 2 * STEADY_RADIUS - 1) continue
    const steady = [...before, ...after].map((j) => one(j)!)
    const lo = Math.min(...steady)
    if (Math.max(...steady) > STEADY_SPREAD * lo || lo <= 0) continue
    const step = median(steady)
    // Two-step differences over pairs of steady frames on one side, so none straddles k or a hold.
    const twos = [...before.slice(0, -1), ...after.slice(1)].map(two).filter((x): x is number => x !== null)
    if (twos.length < 2 * STEADY_RADIUS - 3) continue
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
      const hold = holdBefore.get(k)
      const motion = `Motion into ${label(i)} is ${ratio.toFixed(1)}x its steady neighbours, as big as two steps of their motion`
      if (hold === undefined)
        return finding(range, {
          rule: "dropped-frames",
          severity: "warning",
          index: i,
          message: `${motion}: a frame between ${address(i - 1)} and ${address(i)} looks dropped.`,
          view: "diff"
        })
      const [a, b] = [range.first + hold[0], range.first + hold[1]]
      const held = a === b ? label(a) : `${label(a)} to ${label(b)}`
      return finding(range, {
        rule: "dropped-frames",
        severity: "warning",
        index: i,
        context: [a, b],
        message: `${motion}: ${address(i)} skips a step after the hold at ${held}, so the frame that should have shown that step was dropped.`,
        view: "diff"
      })
    })
  return [
    ...irregular,
    ...regular.map((c) => cadenceFinding(range, input.labelStyle, "dropped-frames", c))
  ].sort((a, b) => a.index - b.index)
}
