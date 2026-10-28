import { type Address, type FrameIndex, type KymoError, type Source } from "@kymo/core"
import { type Target, planGrid } from "@kymo/layout"
import { Effect } from "effect"
import type { ViewImage } from "./Output.ts"
import { checkFrames, frameRef, frameSize, readFrames, spanLabel, spanOf } from "./internal/Frames.ts"
import { ONLY, writeImage } from "./internal/Pages.ts"
import { onionSkin } from "./internal/Pixels.ts"
import { label } from "./internal/Svg.ts"

/** Fewer frames give no stable background to separate motion from. */
export const ONION_MIN_FRAMES = 3
/** More frames turn the trail into a smear. */
export const ONION_MAX_FRAMES = 16

export interface OnionOptions {
  readonly source: Source
  /** Frames in time order, oldest first. */
  readonly frames: ReadonlyArray<FrameIndex>
  readonly outDir: string
  readonly target: Target
  readonly labelStyle: Address.LabelStyle
}

/**
 * Several frames blended into one image: the static background once, each frame's moving
 * pixels on top, older ones tinted and fainter, the newest at full strength. Shows path and
 * spacing. Written as `<span>.onion.png`, labelled `0f-08s10f #0-#250` (by label style).
 */
export const onion = Effect.fn("onion")(function* (o: OnionOptions): Effect.fn.Return<ViewImage, KymoError> {
  const { timeline } = o.source
  yield* checkFrames(o.source, o.frames, { min: ONION_MIN_FRAMES, max: ONION_MAX_FRAMES })
  const size = yield* frameSize(o.source)
  const first = o.frames[0]!
  const last = o.frames[o.frames.length - 1]!
  const text = spanLabel(timeline, first, last, o.labelStyle)
  const plan = yield* Effect.fromResult(
    planGrid({ count: 1, frame: size, target: o.target, labelChars: text.length })
  )
  const cell = plan.cells[0]!
  const decoded = yield* readFrames(o.source, o.frames, Math.max(plan.frame.width, plan.frame.height))
  return yield* writeImage(
    { view: "onion", outDir: o.outDir, target: o.target, fileName: (span) => `${span}.onion.png` },
    {
      span: spanOf(timeline, o.frames),
      frames: decoded.map((f) => frameRef(timeline, f)),
      drawing: {
        width: plan.width,
        height: plan.height,
        tiles: [{ image: onionSkin(decoded.map((f) => f.image)), rect: cell.frame }],
        overlay: label(cell.label, text)
      }
    },
    ONLY
  )
})
