import { Address } from "@kymo/core"
import { BLACK, type PixelInput, runs } from "./FrameTiming.ts"
import { type Finding, finding } from "./Finding.ts"
import { levelsAbove } from "./Pixels.ts"

import { visibleFloor } from "./Visible.ts"

export { type PixelInput, droppedFrames, duplicateFrames } from "./FrameTiming.ts"

/** A flicker steps luma at least this much and then comes back. */
const FLICKER_STEP = 0.06
/**
 * A flicker is an error when at least this share of the frame flashes (changes visibly into the
 * flash and back out of it), whatever the page's brightness: a white flash on a light page moves the
 * mean luma little but wipes the whole page. Below it, a local blink, it is a warning.
 */
const FLICKER_ERROR_AREA = 0.25

export const flicker = ({ scan, labelStyle }: PixelInput): Array<Finding> => {
  const { range } = scan
  const l = scan.frames.map((f) => f.luma)
  const levels = scan.frames.flatMap((f) => (f.levels === null ? [] : [f.levels]))
  const floor = visibleFloor(levels)
  const changed = (k: number) => {
    const lv = scan.frames[k]?.levels
    return lv == null ? 0 : levelsAbove(lv, floor)
  }
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
    const area = Math.min(changed(k), changed(k + 1))
    return [
      finding(range, {
        rule: "flicker",
        severity: area >= FLICKER_ERROR_AREA ? "error" : "warning",
        index: i,
        message: `${Address.styledLabel(range.rate, i, labelStyle)} is ${up > 0 ? "brighter" : "darker"} than both neighbours by ${(step * 100).toFixed(0)}% luma for one frame, over ${(area * 100).toFixed(0)}% of the frame: a flicker.`,
        view: "diff"
      })
    ]
  })
}

export const blackFrames = ({ scan, labelStyle }: PixelInput): Array<Finding> => {
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
      message: `${count} near-black frame${count > 1 ? "s" : ""} from ${Address.styledLabel(range.rate, first, labelStyle)}${atEdge ? " at the edge of the range (a fade in or out?)" : " in the middle of the range"}.`,
      view: "sheet"
    })
  })
}
