import { Address, type Size, type Track } from "@kymo/core"
import { type Finding, finding } from "./Finding.ts"
import type { FrameRange } from "./Range.ts"
import { knownSamples, movingSegment } from "./Segment.ts"
import { round } from "./Stats.ts"
import type { RegionTrack } from "./Tracker.ts"

/** A reversal smaller than this fraction of the segment's travel is noise. */
const REVERSAL = 0.02

export const safeArea = (
  range: FrameRange,
  size: Size,
  margin: number,
  regions: ReadonlyArray<RegionTrack>
): Array<Finding> => {
  const left = margin * size.width
  const top = margin * size.height
  const right = size.width - left
  const bottom = size.height - top
  return regions.flatMap((region) => {
    const overshoot = (i: number): number => {
      const x = region.x.samples[i]
      const y = region.y.samples[i]
      const w = region.w.samples[i]
      const h = region.h.samples[i]
      if (x == null || y == null || w == null || h == null) return 0
      return Math.max(0, left - x, top - y, x + w - right, y + h - bottom)
    }
    const out: Array<Finding> = []
    let i = range.first
    while (i <= range.last) {
      if (overshoot(i) <= 0) {
        i++
        continue
      }
      const start = i
      let worst = 0
      let worstAt = i
      while (i <= range.last && overshoot(i) > 0) {
        if (overshoot(i) > worst) {
          worst = overshoot(i)
          worstAt = i
        }
        i++
      }
      out.push(
        finding(range, {
          rule: "safe-area",
          severity: "warning",
          index: start,
          last: i - 1,
          message: `${region.name} leaves the ${Math.round(margin * 100)}% safe area from ${Address.label(range.rate, start)}, by up to ${worst.toFixed(1)}px at ${Address.format(range.rate, worstAt)}.`,
          view: "grid",
          context: [worstAt]
        })
      )
    }
    return out
  })
}

export const nonMonotonic = (range: FrameRange, tracks: ReadonlyArray<Track>): Array<Finding> =>
  tracks.flatMap((track) => {
    const samples = knownSamples(track, range)
    const segment = movingSegment(samples)
    if (!segment) return []
    const inside = samples.filter(([i]) => i >= segment.from && i <= segment.to)
    const v0 = inside[0]![1]
    const v1 = inside[inside.length - 1]![1]
    const dir = Math.sign(v1 - v0)
    if (dir === 0) return []
    const tol = REVERSAL * Math.abs(v1 - v0)
    let extreme = v0
    let extremeAt = inside[0]![0]
    for (const [i, v] of inside) {
      // Past the target (a spring overshooting) is settling, not reversing.
      if (dir * (extreme - v1) >= 0) break
      if (dir * (v - extreme) > 0) {
        extreme = v
        extremeAt = i
      } else if (dir * (extreme - v) > tol) {
        const recover = inside.find(([j, w]) => j > i && dir * (w - extreme) >= 0)?.[0] ?? segment.to
        return [
          finding(range, {
            rule: "non-monotonic",
            severity: "warning",
            index: i,
            last: recover,
            message: `${track.name} reverses on its way from ${round(v0)} to ${round(v1)}: it reached ${round(extreme)} at ${Address.format(range.rate, extremeAt)}, then went back to ${round(v)} at ${Address.label(range.rate, i)}.`,
            view: "onion",
            context: [extremeAt]
          })
        ]
      }
    }
    return []
  })
