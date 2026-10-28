import { Address, fpsOf } from "@kymo/core"
import type { Cuts } from "./Cuts.ts"
import { type Finding, finding } from "./Finding.ts"
import { STILL_FLOOR } from "./Motion.ts"
import type { Scan } from "./Scan.ts"
import { median } from "./Stats.ts"

/** Rules that read pixel statistics. Each returns findings in frame order. */
export interface PixelInput {
  readonly scan: Scan
  readonly cuts: Cuts
}

/** At most this much change counts as a repeated frame (codec noise included). */
const DUPLICATE = 0.0005
/** Longest repeat, in seconds, that counts as a held or stalled frame; anything longer is a pause. */
const MAX_HELD_SECONDS = 0.25
/** Mean luma below this is black. */
const BLACK = 0.03
/** A flicker steps luma at least this much and then comes back. */
const FLICKER_STEP = 0.06
const FLICKER_ERROR = 0.2

const cutFrames = (cuts: Cuts): Set<number> => {
  const s = new Set<number>()
  for (const c of cuts.cuts) for (let i = c.from.index + 1; i <= c.to.index; i++) s.add(i)
  return s
}

/** Motion per scan position; undefined where unknown or across a cut. */
const shotMotion = ({ scan, cuts }: PixelInput): Array<number | undefined> => {
  const cut = cutFrames(cuts)
  return scan.frames.map((f) => (f.motion === null || cut.has(f.index) ? undefined : f.motion))
}

const runs = (flags: ReadonlyArray<boolean>): Array<[number, number]> => {
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

export const duplicateFrames = (input: PixelInput): Array<Finding> => {
  const { range } = input.scan
  const m = shotMotion(input)
  // Repeated black frames are black-frames' finding, not a held frame.
  const isDup = m.map((v, k) => v !== undefined && v <= DUPLICATE && input.scan.frames[k]!.luma >= BLACK)
  const moving = (v: number | undefined): v is number => v !== undefined && v > STILL_FLOOR
  return runs(isDup).flatMap(([a, b]) => {
    // A held frame is a short repeat inside motion that carries on through it. A longer still
    // stretch is a pause, and a still shot next to one bright frame is not moving at all.
    if (b - a + 1 > Math.max(1, Math.round(MAX_HELD_SECONDS * fpsOf(range.rate)))) return []
    if (!moving(m[a - 1]) || !moving(m[b + 1])) return []
    const first = range.first + a
    const last = range.first + b
    const count = b - a + 1
    return [
      finding(range, {
        rule: "duplicate-frames",
        severity: "warning",
        index: first,
        last,
        message:
          count === 1
            ? `${Address.label(range.rate, first)} repeats the frame before it while the picture is moving: a held or duplicated frame.`
            : `${count} frames from ${Address.label(range.rate, first)} repeat the frame before them while the picture is moving.`,
        view: "diff",
        at: [first - 1, first, last, last + 1]
      })
    ]
  })
}

export const droppedFrames = (input: PixelInput): Array<Finding> => {
  const { range } = input.scan
  const m = shotMotion(input)
  return m.flatMap((v, k) => {
    const steady = [m[k - 2], m[k - 1], m[k + 1], m[k + 2]].filter((x): x is number => x !== undefined)
    if (v === undefined || steady.length < 4) return []
    const base = median(steady)
    const lo = Math.min(...steady)
    const hi = Math.max(...steady)
    if (base <= 2 * STILL_FLOOR || hi > 1.3 * lo) return []
    const ratio = v / base
    if (ratio < 1.7 || ratio > 2.6) return []
    const i = range.first + k
    return [
      finding(range, {
        rule: "dropped-frames",
        severity: "warning",
        index: i,
        message: `Motion into ${Address.label(range.rate, i)} is ${ratio.toFixed(1)}x its steady neighbours: a frame between ${Address.format(range.rate, i - 1)} and ${Address.format(range.rate, i)} looks dropped.`,
        view: "diff",
        at: [i - 2, i - 1, i, i + 1]
      })
    ]
  })
}

export const flicker = ({ scan }: PixelInput): Array<Finding> => {
  const { range } = scan
  const l = scan.frames.map((f) => f.luma)
  return l.flatMap((v, k) => {
    const before = l[k - 1]
    const after = l[k + 1]
    if (before === undefined || after === undefined) return []
    const up = v - before
    const step = Math.abs(up)
    if (step < FLICKER_STEP || Math.sign(after - v) !== -Math.sign(up)) return []
    if (Math.abs(after - before) > 0.3 * step) return []
    const calm = [
      l[k - 2] === undefined ? 0 : before - l[k - 2]!,
      l[k + 2] === undefined ? 0 : l[k + 2]! - after
    ]
    if (calm.some((d) => Math.abs(d) > 0.25 * step)) return []
    const i = range.first + k
    return [
      finding(range, {
        rule: "flicker",
        severity: step >= FLICKER_ERROR ? "error" : "warning",
        index: i,
        message: `${Address.label(range.rate, i)} is ${up > 0 ? "brighter" : "darker"} than both neighbours by ${(step * 100).toFixed(0)}% luma for one frame: a flicker.`,
        view: "diff",
        at: [i - 1, i, i + 1]
      })
    ]
  })
}

export const blackFrames = ({ scan }: PixelInput): Array<Finding> => {
  const { range } = scan
  return runs(scan.frames.map((f) => f.luma < BLACK)).map(([a, b]) => {
    const first = range.first + a
    const last = range.first + b
    const atEdge = first === range.first || last === range.last
    const count = b - a + 1
    return finding(range, {
      rule: "black-frames",
      severity: atEdge ? "info" : "warning",
      index: first,
      last,
      message: `${count} near-black frame${count > 1 ? "s" : ""} from ${Address.label(range.rate, first)}${atEdge ? " at the edge of the range (a fade in or out?)" : " in the middle of the range"}.`,
      view: "sheet",
      at: [first - 1, first, last, last + 1]
    })
  })
}
