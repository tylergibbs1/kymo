import { Result, Schema } from "effect"
import { IntParam, NumberParam } from "../../Params.ts"
import { Canvas } from "../Canvas.ts"
import { COLORS, boxTracks, defineScene, invalid, perFrame } from "../Scene.ts"

/**
 * A ball pulled toward a wall on the right (gravity turned sideways). It falls from rest, hits the wall
 * at `impact`, and rebounds in shrinking parabolic arcs; each impact lands exactly on a frame. After the
 * last impact the ball rests against the wall.
 */
export const bounce = defineScene({
  name: "bounce",
  summary:
    "bounce: a ball falls sideways into a wall on the right and rebounds. impact=frame of first hit (default frames/3), bounces=N impacts (default 3), period=frames of the first rebound (default 80% of impact, at most 2×impact), decay=0..1 shrink per rebound (default 0.6). Markers impact1..N.",
  params: {
    impact: Schema.optionalKey(IntParam(2, 100_000)),
    bounces: Schema.optionalKey(IntParam(1, 50)),
    period: Schema.optionalKey(IntParam(2, 100_000)),
    decay: Schema.optionalKey(NumberParam(0.05, 1))
  },
  make: (clip, p) => {
    const first = p.impact ?? Math.max(2, Math.round(clip.frames / 3))
    const period = p.period ?? Math.max(2, Math.round(first * 0.8))
    const count = p.bounces ?? 3
    const decay = p.decay ?? 0.6
    if (period > 2 * first) {
      return invalid(
        "bounce",
        `period=${period} is more than twice impact=${first}, so the rebound would fly past the ball's start.`,
        `Use period<=${2 * first}, or a later impact.`
      )
    }
    const impacts = [first]
    for (let k = 1; k < count; k++) {
      impacts.push(impacts[k - 1]! + Math.max(2, Math.round(period * decay ** (k - 1))))
    }
    const last = impacts[impacts.length - 1]!
    if (last >= clip.frames) {
      return invalid(
        "bounce",
        `impact ${count} would land on frame ${last}, past the clip's ${clip.frames} frames.`,
        `Use frames=${last + 10}, fewer bounces, or an earlier impact.`
      )
    }

    const { width, height } = clip.size
    const d = Math.round(height * 0.12)
    const wallX = width * 0.9
    const contact = wallX - d
    const rest = width * 0.1
    const fps = clip.rate.num / clip.rate.den
    const t1 = first / fps
    const g = (2 * (contact - rest)) / (t1 * t1)

    const leftAt = (i: number): number => {
      if (i <= first) {
        const t = i / fps
        return rest + 0.5 * g * t * t
      }
      for (let k = 0; k < impacts.length - 1; k++) {
        const a = impacts[k]!
        const b = impacts[k + 1]!
        if (i <= b) {
          const flight = (b - a) / fps
          const tau = (i - a) / fps
          return contact - ((g * flight) / 2) * tau + 0.5 * g * tau * tau
        }
      }
      return contact
    }
    const y = (height - d) / 2
    const boxes = perFrame(clip, (i) => ({ x: leftAt(i), y, w: d, h: d, opacity: 1 }))

    return Result.succeed({
      markers: impacts.map((index, k) => ({ name: `impact${k + 1}`, index })),
      tracks: boxTracks(boxes),
      render: (i) => {
        const b = boxes[i]!
        return new Canvas(clip.size, COLORS.background)
          .rect(wallX, 0, width - wallX, height, COLORS.wall)
          .disc(b.x + d / 2, b.y + d / 2, d / 2, COLORS.accent)
          .toImage()
      }
    })
  }
})
