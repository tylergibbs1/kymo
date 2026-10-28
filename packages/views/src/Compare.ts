import { type Address, type FrameIndex, type KymoError, type Source } from "@kymo/core"
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

/** A frame of A and the frame of B showing the same moment (the same index when they share a clock). */
export interface FramePair {
  readonly a: FrameIndex
  readonly b: FrameIndex
}

export interface CompareOptions extends Paging {
  readonly a: Source
  readonly b: Source
  /** The frames to compare: each frame of A with its frame of B. */
  readonly pairs: ReadonlyArray<FramePair>
  readonly mode?: CompareMode
  readonly outDir: string
  readonly target: Target
  readonly labelStyle: Address.LabelStyle
}

/**
 * Two sources at the same moments. Side by side, each cell is labelled with its own source's
 * address: `clip1@08s10f #250` / `clip2@08s10f #250`, or `clip2@20s25f #1250` when B runs on another
 * clock. In diff mode B is resized to A and the cell shows |A − B|, labelled `clip1-clip2@08s10f #250`
 * (`clip1@… − clip2@…` when the two addresses differ). Written as `<span>.compare.<a>.<b>.png`
 * (`compare-diff` in diff mode), the span on A's clock.
 */
export const compare = Effect.fn("compare")(function* (
  o: CompareOptions
): Effect.fn.Return<ViewResult, KymoError> {
  const mode = o.mode ?? "side-by-side"
  const ta = o.a.timeline
  const tb = o.b.timeline
  yield* checkFrames(
    o.a,
    o.pairs.map((p) => p.a)
  )
  yield* checkFrames(
    o.b,
    o.pairs.map((p) => p.b)
  )
  const size = yield* frameSize(o.a)
  yield* frameSize(o.b)
  const labelsFor = (p: FramePair): ReadonlyArray<string> => {
    const la = frameLabel(ta, p.a, o.labelStyle, true)
    const lb = frameLabel(tb, p.b, o.labelStyle, true)
    if (mode !== "diff") return [la, lb]
    const own = frameLabel(ta, p.a, o.labelStyle, false)
    const same = own === frameLabel(tb, p.b, o.labelStyle, false)
    return [same ? `${ta.handle}-${tb.handle}@${own}` : `${la} − ${lb}`]
  }
  const pages = yield* Effect.fromResult(
    paginate({
      items: o.pairs.length,
      cellsPerItem: mode === "diff" ? 1 : 2,
      frame: size,
      target: o.target,
      labelChars: Math.max(...o.pairs.flatMap(labelsFor).map((l) => l.length)),
      cursor: o.cursor,
      maxSheets: o.maxSheets
    })
  )
  const destination = {
    view: "compare",
    target: o.target,
    outDir: o.outDir,
    fileName: (span: string) =>
      `${span}.${mode === "diff" ? "compare-diff" : "compare"}.${ta.handle}.${tb.handle}.png`
  } as const
  return yield* writePages(destination, pages, o.pairs, (plan, pairs) =>
    Effect.gen(function* () {
      const maxEdge = Math.max(plan.frame.width, plan.frame.height)
      const fromA = yield* readFrames(
        o.a,
        pairs.map((p) => p.a),
        maxEdge
      )
      const fromB = yield* readFrames(
        o.b,
        pairs.map((p) => p.b),
        maxEdge
      )
      const images =
        mode === "diff"
          ? yield* Effect.forEach(fromA, (fa, k) =>
              Effect.map(resize(fromB[k]!.image, fa.image.width, fa.image.height), (b) =>
                heatmap(fa.image, b)
              )
            )
          : fromA.flatMap((fa, k) => [fa.image, fromB[k]!.image])
      const labels = pairs.flatMap(labelsFor)
      return {
        span: spanOf(
          ta,
          pairs.map((p) => p.a)
        ),
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
