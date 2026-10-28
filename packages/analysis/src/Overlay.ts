import type { Gray } from "./Pixels.ts"
import { median } from "./Stats.ts"

/**
 * Something drawn over an unchanged picture (a dimming backdrop, a dialog) is not a new shot. Outside
 * compact elements covering at most this share of the frame, the new picture is the old one under a
 * single luma map (a gain and an offset) to within this many luma steps; that keeps at least this share
 * of the old picture's structure, and this much of its contrast (standard deviation, luma steps) shows.
 */
const OVERLAY_REGION = 1 / 3
const OVERLAY_TOLERANCE = 4
const OVERLAY_STRUCTURE = 2 / 3
const OVERLAY_CONTRAST = 12

/** The value that splits `pairs` into halves of equal total weight. */
const weightedMedian = (pairs: Array<readonly [value: number, weight: number]>): number => {
  pairs.sort((p, q) => p[0] - q[0])
  const half = pairs.reduce((sum, p) => sum + p[1], 0) / 2
  let seen = 0
  for (const [value, weight] of pairs) if ((seen += weight) >= half) return value
  return 0
}

/**
 * The one luma map `y = gain * x + offset` that most of the picture follows, robust to what was drawn
 * over part of it: the median slope over pairs of cells, each weighted by how far apart their levels are
 * (a weighted Theil-Sen fit), then the median offset.
 */
const lumaMap = (x: Uint8Array, y: Uint8Array): { gain: number; offset: number } => {
  const slopes: Array<readonly [number, number]> = []
  for (let i = 0; i < x.length; i++)
    for (let j = i + 1; j < x.length; j++) {
      const dx = x[j]! - x[i]!
      if (Math.abs(dx) >= OVERLAY_TOLERANCE) slopes.push([(y[j]! - y[i]!) / dx, Math.abs(dx)])
    }
  const gain = weightedMedian(slopes)
  return { gain, offset: median(Array.from(x, (v, i) => y[i]! - gain * v)) }
}

/**
 * The area the marked cells take up as compact elements: the summed bounding boxes of their connected
 * groups. A dialog and a spinner are two small boxes; the edges of a new page's layout run across the
 * whole frame.
 */
const elementArea = (marked: ReadonlyArray<boolean>, width: number): number => {
  const height = marked.length / width
  const seen = marked.map(() => false)
  let area = 0
  for (let start = 0; start < marked.length; start++) {
    if (!marked[start] || seen[start]) continue
    seen[start] = true
    const stack = [start]
    const box = { left: width, right: 0, top: height, bottom: 0 }
    for (let cell = stack.pop(); cell !== undefined; cell = stack.pop()) {
      const [col, row] = [cell % width, Math.floor(cell / width)]
      box.left = Math.min(box.left, col)
      box.right = Math.max(box.right, col)
      box.top = Math.min(box.top, row)
      box.bottom = Math.max(box.bottom, row)
      for (let r = Math.max(0, row - 1); r <= Math.min(height - 1, row + 1); r++)
        for (let c = Math.max(0, col - 1); c <= Math.min(width - 1, col + 1); c++) {
          const next = r * width + c
          if (marked[next] && !seen[next]) {
            seen[next] = true
            stack.push(next)
          }
        }
    }
    area += (box.right - box.left + 1) * (box.bottom - box.top + 1)
  }
  return area
}

/**
 * Whether `b` is `a` with something drawn over it: outside a few compact elements covering at most
 * `OVERLAY_REGION` of the frame, `b` is `a` under one luma map (a dimming backdrop, a brightness change)
 * with `a`'s contrast still showing. A fade to or from black is not: no contrast survives it. A new
 * picture is not: its structure differs all over the frame. Both are thumbnails of one source.
 */
export const isOverlay = (a: Gray, b: Gray): boolean => {
  const x = a.data
  const y = b.data
  const { gain, offset } = lumaMap(x, y)
  const drawn = Array.from(x, (v, i) => Math.abs(y[i]! - (gain * v + offset)) > OVERLAY_TOLERANCE)
  const kept = Array.from(x).filter((_, i) => !drawn[i])
  if (kept.length === 0 || elementArea(drawn, a.width) > OVERLAY_REGION * x.length) return false
  // The old picture's structure (what stands out from its commonest level) is still there, not moved.
  const level = median(Array.from(x))
  const structure = (keep: (i: number) => boolean) =>
    x.reduce((sum, v, i) => (keep(i) ? sum + (v - level) ** 2 : sum), 0)
  const whole = structure(() => true)
  if (whole === 0 || structure((i) => !drawn[i]) < OVERLAY_STRUCTURE * whole) return false
  const mean = kept.reduce((sum, v) => sum + v, 0) / kept.length
  const spread = Math.sqrt(kept.reduce((sum, v) => sum + (v - mean) ** 2, 0) / kept.length)
  return gain * spread >= OVERLAY_CONTRAST
}
