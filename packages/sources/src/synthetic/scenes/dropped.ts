import { Result, Schema } from "effect"
import { Canvas } from "../Canvas.ts"
import { COLORS, boxTracks, defineScene, invalid, perFrame } from "../Scene.ts"

const DupList = Schema.String.check(
  Schema.isPattern(/^\d+(,\d+)*$/, { expected: "frame indices separated by commas, like 20,45,46" })
)

/**
 * Smooth linear motion where each frame in `dups` repeats the previous frame's picture (a dropped
 * frame), then motion resumes at its true position.
 */
export const dropped = defineScene({
  name: "dropped",
  summary:
    "dropped: a square moves smoothly, but listed frames repeat the previous frame. dups=comma-separated frame indices, each >= 1 (default three at 25%, 50%, 75%). Markers dup1..N.",
  params: { dups: Schema.optionalKey(DupList) },
  make: (clip, p) => {
    const dups = p.dups
      ? [...new Set(p.dups.split(",").map(Number))].sort((a, b) => a - b)
      : [0.25, 0.5, 0.75].map((f) => Math.max(1, Math.round(clip.frames * f)))
    const bad = dups.filter((d) => d < 1 || d >= clip.frames)
    if (bad.length > 0) {
      return invalid(
        "dropped",
        `dups ${bad.join(", ")} must be between 1 and ${clip.frames - 1}.`,
        "Frame 0 has no previous frame to repeat; pick indices inside the clip."
      )
    }
    const { width, height } = clip.size
    const side = Math.round(height * 0.2)
    const trueX = (i: number) => width * 0.05 + ((width * 0.9 - side) * i) / Math.max(1, clip.frames - 1)
    const dupSet = new Set(dups)
    const shown: Array<number> = []
    for (let i = 0; i < clip.frames; i++) shown.push(dupSet.has(i) ? shown[i - 1]! : i)
    const y = (height - side) / 2
    const boxes = shown.map((s) => ({ x: trueX(s), y, w: side, h: side, opacity: 1 }))
    return Result.succeed({
      markers: dups.map((index, k) => ({ name: `dup${k + 1}`, index })),
      tracks: [
        ...boxTracks(boxes),
        { name: "dup", unit: "flag", samples: perFrame(clip, (i) => (dupSet.has(i) ? 1 : 0)) }
      ],
      render: (i) => {
        const b = boxes[i]!
        return new Canvas(clip.size, COLORS.background).rect(b.x, b.y, b.w, b.h, COLORS.subject).toImage()
      }
    })
  }
})
