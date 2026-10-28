import { Result, Schema } from "effect"
import { IntParam } from "../../Params.ts"
import { Canvas } from "../Canvas.ts"
import { COLORS, boxTracks, defineScene, invalid, perFrame } from "../Scene.ts"

/**
 * A box drifts right at constant speed from the centre. Its right edge crosses the safe-area line
 * (`margin`% in from the right) between frames `exit - 1` and `exit`.
 */
export const safeArea = defineScene({
  name: "safe-area",
  summary:
    "safe-area: a box drifts right from the centre and leaves the safe area. margin=5|10 percent inset (default 10), exit=first frame with the box outside (default 60%). Marker exit_safe.",
  params: {
    margin: Schema.optionalKey(Schema.Literals(["5", "10"])),
    exit: Schema.optionalKey(IntParam(1, 100_000))
  },
  make: (clip, p) => {
    const margin = Number(p.margin ?? "10") / 100
    const exit = p.exit ?? Math.max(1, Math.round(clip.frames * 0.6))
    if (exit >= clip.frames) {
      return invalid(
        "safe-area",
        `exit=${exit} is past the last frame (${clip.frames - 1}).`,
        "Pick a frame inside the clip."
      )
    }
    const { width, height } = clip.size
    const side = Math.round(height * 0.15)
    const safeRight = width * (1 - margin)
    const startRight = (width + side) / 2
    const speed = (safeRight - startRight) / (exit - 0.5)
    const y = (height - side) / 2
    const boxes = perFrame(clip, (i) => ({
      x: safeRight + speed * (i - exit + 0.5) - side,
      y,
      w: side,
      h: side,
      opacity: 1
    }))
    return Result.succeed({
      markers: [{ name: "exit_safe", index: exit }],
      tracks: boxTracks(boxes),
      render: (i) => {
        const b = boxes[i]!
        return new Canvas(clip.size, COLORS.background).rect(b.x, b.y, b.w, b.h, COLORS.subject).toImage()
      }
    })
  }
})
