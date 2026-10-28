import { type FrameIndex, type KymoError, type Source } from "@kymo/core"
import { type Target, paginate } from "@kymo/layout"
import { Effect } from "effect"
import type { ViewResult } from "./Output.ts"
import type { Paging } from "./Sheet.ts"
import { checkFrames, frameLabel, frameRef, frameSize, readFrames, spanOf } from "./internal/Frames.ts"
import { resize } from "./internal/Draw.ts"
import { writePages } from "./internal/Pages.ts"
import { heatmap } from "./internal/Pixels.ts"
import { label } from "./internal/Svg.ts"

/** `side-by-side`: A and B per row. `diff`: one |A − B| heatmap per frame. */
export type CompareMode = "side-by-side" | "diff"

export interface CompareOptions extends Paging {
  readonly a: Source
  readonly b: Source
  /** Frame indices, applied to both sources. */
  readonly frames: ReadonlyArray<FrameIndex>
  readonly mode?: CompareMode
  readonly outDir: string
  readonly target: Target
}

/**
 * Two sources at the same frames. Side by side, each cell is labelled `clip1@08s10f #250` /
 * `clip2@08s10f #250`; in diff mode B is resized to A and the cell shows |A − B|, labelled
 * `clip1-clip2@08s10f #250`. Written as `<span>.compare.<a>.<b>.png` (`compare-diff` in diff mode).
 */
export const compare = Effect.fn("compare")(function* (
  o: CompareOptions
): Effect.fn.Return<ViewResult, KymoError> {
  const mode = o.mode ?? "side-by-side"
  const ta = o.a.timeline
  const tb = o.b.timeline
  yield* checkFrames(o.a, o.frames)
  yield* checkFrames(o.b, o.frames)
  const size = yield* frameSize(o.a)
  yield* frameSize(o.b)
  const labelsFor = (i: number): ReadonlyArray<string> =>
    mode === "diff"
      ? [`${ta.handle}-${tb.handle}@${frameLabel(ta, i, false)}`]
      : [frameLabel(ta, i, true), frameLabel(tb, i, true)]
  const pages = yield* Effect.fromResult(
    paginate({
      items: o.frames.length,
      cellsPerItem: mode === "diff" ? 1 : 2,
      frame: size,
      target: o.target,
      labelChars: Math.max(...o.frames.flatMap(labelsFor).map((l) => l.length)),
      cursor: o.cursor,
      maxSheets: o.maxSheets
    })
  )
  const destination = {
    view: "compare",
    outDir: o.outDir,
    fileName: (span: string) =>
      `${span}.${mode === "diff" ? "compare-diff" : "compare"}.${ta.handle}.${tb.handle}.png`
  } as const
  return yield* writePages(destination, pages, o.frames, (plan, indices) =>
    Effect.gen(function* () {
      const maxEdge = Math.max(plan.frame.width, plan.frame.height)
      const fromA = yield* readFrames(o.a, indices, maxEdge)
      const fromB = yield* readFrames(o.b, indices, maxEdge)
      const images =
        mode === "diff"
          ? yield* Effect.forEach(fromA, (fa, k) =>
              Effect.map(resize(fromB[k]!.image, fa.image.width, fa.image.height), (b) =>
                heatmap(fa.image, b)
              )
            )
          : fromA.flatMap((fa, k) => [fa.image, fromB[k]!.image])
      const labels = indices.flatMap(labelsFor)
      return {
        span: spanOf(ta, indices),
        frames: fromA.map((f) => frameRef(ta, f)),
        drawing: {
          width: plan.width,
          height: plan.height,
          tiles: images.map((image, k) => ({ image, rect: plan.cells[k]!.frame })),
          overlay: plan.cells.map((cell, k) => label(cell.label, labels[k]!)).join("")
        }
      }
    })
  )
})
