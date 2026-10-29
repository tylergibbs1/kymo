import {
  type Address,
  type FrameIndex,
  InvalidInput,
  type KymoError,
  type Source,
  frameIndex
} from "@kymo/core"
import { type Target, paginate } from "@kymo/layout"
import { Effect } from "effect"
import type { ViewResult } from "./Output.ts"
import type { Paging } from "./Sheet.ts"
import { checkFrames, frameLabel, frameRef, frameSize, readFrames, spanOf } from "./internal/Frames.ts"
import { writePages } from "./internal/Pages.ts"
import { heatmap } from "./internal/Pixels.ts"
import { label } from "./internal/Svg.ts"

export interface DiffOptions extends Paging {
  readonly source: Source
  /** Each frame N is drawn as |N − (N−1)|, labelled with N's address. */
  readonly frames: ReadonlyArray<FrameIndex>
  /** Levels (0..255) of change drawn black: the clip's noise. Above it the colour scale is fixed. */
  readonly floor: number
  readonly outDir: string
  readonly target: Target
  readonly labelStyle: Address.LabelStyle
}

/**
 * What changed since the previous frame, as heatmaps on a fixed scale (black = no change beyond
 * `floor`), written as `<span>.diff.png`.
 */
export const diff = Effect.fn("diff")(function* (o: DiffOptions): Effect.fn.Return<ViewResult, KymoError> {
  const { timeline } = o.source
  yield* checkFrames(o.source, o.frames)
  if (o.frames.includes(frameIndex(0)))
    return yield* new InvalidInput({
      message: "0f has no previous frame to diff against.",
      hint: "Start the range at 1f (#1) or later."
    })
  const size = yield* frameSize(o.source)
  const pages = yield* Effect.fromResult(
    paginate({
      items: o.frames.length,
      frame: size,
      target: o.target,
      labelChars: Math.max(...o.frames.map((i) => frameLabel(timeline, i, o.labelStyle, false).length)),
      cursor: o.cursor,
      maxSheets: o.maxSheets
    })
  )
  const destination = {
    view: "diff",
    target: o.target,
    outDir: o.outDir,
    fileName: (span: string) => `${span}.diff.png`
  } as const
  return yield* writePages(destination, pages, o.frames, (plan, indices) => {
    const wanted = [...new Set(indices.flatMap((i) => [i - 1, i]))].sort((a, b) => a - b).map(frameIndex)
    return Effect.map(
      readFrames(o.source, wanted, Math.max(plan.frame.width, plan.frame.height)),
      (decoded) => {
        const byIndex = new Map(decoded.map((f) => [f.index as number, f]))
        const current = indices.map((i) => byIndex.get(i)!)
        return {
          span: spanOf(timeline, indices),
          frames: current.map((f) => frameRef(timeline, f)),
          drawing: {
            width: plan.width,
            height: plan.height,
            tiles: current.map((f, k) => ({
              image: heatmap(byIndex.get(f.index - 1)!.image, f.image, o.floor),
              rect: plan.cells[k]!.frame
            })),
            overlay: plan.cells
              .map((cell, k) => label(cell.label, frameLabel(timeline, indices[k]!, o.labelStyle, false)))
              .join("")
          }
        }
      }
    )
  })
})
