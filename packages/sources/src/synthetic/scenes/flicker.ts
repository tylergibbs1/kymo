import { Result, Schema } from "effect"
import { IntParam } from "../../Params.ts"
import { Canvas } from "../Canvas.ts"
import { COLORS, boxTracks, defineScene, invalid, perFrame } from "../Scene.ts"

/** A static scene with one frame flashed brighter. */
export const flicker = defineScene({
  name: "flicker",
  summary:
    "flicker: a static box with a one-frame brightness flash. at=frame of the flash (default frames/2), gain=levels added to every channel (default 60, -255..255). Marker flicker.",
  params: {
    at: Schema.optionalKey(IntParam(0, 100_000)),
    gain: Schema.optionalKey(IntParam(-255, 255))
  },
  make: (clip, p) => {
    const at = p.at ?? Math.floor(clip.frames / 2)
    const gain = p.gain ?? 60
    if (at >= clip.frames) {
      return invalid(
        "flicker",
        `at=${at} is past the last frame (${clip.frames - 1}).`,
        "Pick a frame inside the clip."
      )
    }
    const { width, height } = clip.size
    const side = Math.round(height * 0.3)
    const box = { x: (width - side) / 2, y: (height - side) / 2, w: side, h: side, opacity: 1 }
    const still = new Canvas(clip.size, COLORS.background).rect(box.x, box.y, box.w, box.h, COLORS.subject)
    const plain = still.toImage()
    const flashed = still.brighten(gain).toImage()
    return Result.succeed({
      markers: [{ name: "flicker", index: at }],
      tracks: [
        ...boxTracks(perFrame(clip, () => box)),
        { name: "flash.gain", unit: "levels", samples: perFrame(clip, (i) => (i === at ? gain : 0)) }
      ],
      render: (i) => (i === at ? flashed : plain)
    })
  }
})
