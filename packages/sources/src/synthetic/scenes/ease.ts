import { Result, Schema } from "effect"
import { IntParam } from "../../Params.ts"
import { Canvas } from "../Canvas.ts"
import { EasingParam, progress } from "../Easing.ts"
import { COLORS, boxTracks, defineScene, invalid, perFrame } from "../Scene.ts"

/** Below this distance from the end (as a fraction of the travel) a spring counts as settled. */
const SETTLED = 0.001

/** A square moves left to right between `start` and `end` with the chosen easing. */
export const ease = defineScene({
  name: "ease",
  summary:
    "ease: a square moves left→right. easing=linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier(a,b,c,d)|spring(k,c) (default ease-in-out), start=frame (default 10%), end=frame (default 90%; springs settle on their own). Markers motion_start, motion_end.",
  params: {
    easing: Schema.optionalKey(EasingParam),
    start: Schema.optionalKey(IntParam(0, 100_000)),
    end: Schema.optionalKey(IntParam(0, 100_000))
  },
  make: (clip, p) => {
    const easing = p.easing ?? { _tag: "CubicBezier", x1: 0.42, y1: 0, x2: 0.58, y2: 1 }
    const start = p.start ?? Math.round(clip.frames * 0.1)
    const end = p.end ?? Math.round(clip.frames * 0.9)
    if (!(start < end && end < clip.frames)) {
      return invalid(
        "ease",
        `start=${start} and end=${end} must satisfy start < end < frames (${clip.frames}).`,
        "Pick start and end inside the clip, e.g. start=10&end=60, or raise frames."
      )
    }
    const { width, height } = clip.size
    const side = Math.round(height * 0.2)
    const from = width * 0.1
    const to = width * 0.9 - side
    const y = (height - side) / 2
    const spf = clip.rate.den / clip.rate.num
    const amount = perFrame(clip, (i) => progress(easing, (i - start) / (end - start), (i - start) * spf))
    const boxes = amount.map((a) => ({ x: from + (to - from) * a, y, w: side, h: side, opacity: 1 }))

    const settledAt =
      easing._tag === "Spring" ? amount.findLastIndex((a) => Math.abs(1 - a) >= SETTLED) + 1 : end
    const markers = [{ name: "motion_start", index: start }]
    if (settledAt < clip.frames) markers.push({ name: "motion_end", index: settledAt })

    return Result.succeed({
      markers,
      tracks: [...boxTracks(boxes), { name: "ease.progress", unit: "ratio", samples: amount }],
      render: (i) => {
        const b = boxes[i]!
        return new Canvas(clip.size, COLORS.background).rect(b.x, b.y, b.w, b.h, COLORS.subject).toImage()
      }
    })
  }
})
