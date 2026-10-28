import { Result, Schema } from "effect"
import { IntParam } from "../../Params.ts"
import { Canvas } from "../Canvas.ts"
import { COLORS, boxTracks, defineScene, invalid, perFrame } from "../Scene.ts"

/**
 * Two unrelated shots joined at `at`: a square crossing a navy frame, then a disc on orange. With
 * `fade=N` the first N frames from `at` cross-dissolve, ending fully on the second shot.
 */
export const cut = defineScene({
  name: "cut",
  summary:
    "cut: two different shots joined at a known frame. at=first frame of the second shot (default frames/2), fade=frames of cross-dissolve starting at `at` (default 0, a hard cut). Marker cut. Track cut.mix is 0 on shot A, 1 on shot B.",
  params: {
    at: Schema.optionalKey(IntParam(1, 100_000)),
    fade: Schema.optionalKey(IntParam(0, 100_000))
  },
  make: (clip, p) => {
    const at = p.at ?? Math.max(1, Math.floor(clip.frames / 2))
    const fade = p.fade ?? 0
    if (at + fade >= clip.frames) {
      return invalid(
        "cut",
        `at=${at} plus fade=${fade} runs past the last frame (${clip.frames - 1}).`,
        "Cut earlier, shorten the fade, or raise frames."
      )
    }
    const { width, height } = clip.size
    const side = Math.round(height * 0.2)
    const mix = perFrame(clip, (i) => (i < at ? 0 : i >= at + fade ? 1 : (i - at + 1) / (fade + 1)))
    const boxes = perFrame(clip, (i) => ({
      x: width * 0.05 + ((width * 0.9 - side) * i) / Math.max(1, clip.frames - 1),
      y: height * 0.3,
      w: side,
      h: side,
      opacity: 1 - mix[i]!
    }))
    const shotA = (i: number) => {
      const b = boxes[i]!
      return new Canvas(clip.size, COLORS.navy).rect(b.x, b.y, b.w, b.h, COLORS.subject)
    }
    const shotB = (i: number) =>
      new Canvas(clip.size, COLORS.warm).disc(
        width / 2,
        height * (0.4 + (0.2 * i) / Math.max(1, clip.frames - 1)),
        height * 0.2,
        COLORS.background
      )
    return Result.succeed({
      markers: [{ name: "cut", index: at }],
      tracks: [...boxTracks(boxes), { name: "cut.mix", unit: "ratio", samples: mix }],
      render: (i) => {
        const m = mix[i]!
        if (m === 0) return shotA(i).toImage()
        if (m === 1) return shotB(i).toImage()
        return shotA(i).mix(shotB(i), m).toImage()
      }
    })
  }
})
