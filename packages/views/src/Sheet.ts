import type { Address, FrameIndex, KymoError, Source } from "@kymo/core"
import { type Cursor, type Target, paginate } from "@kymo/layout"
import { Effect } from "effect"
import type { ViewResult } from "./Output.ts"
import { checkFrames, frameLabel, frameRef, frameSize, readFrames, spanOf } from "./internal/Frames.ts"
import { writePages } from "./internal/Pages.ts"
import { pixelGrid } from "./internal/PixelGrid.ts"
import { label } from "./internal/Svg.ts"

/** Options every paginated view shares. */
export interface Paging {
  /** `next` from a previous result of the same request. */
  readonly cursor?: Cursor | undefined
  /** Sheets to draw this call (default 4). */
  readonly maxSheets?: number | undefined
}

export interface SheetOptions extends Paging {
  readonly source: Source
  readonly frames: ReadonlyArray<FrameIndex>
  readonly outDir: string
  readonly target: Target
  readonly labelStyle: Address.LabelStyle
  /** Label as `clip1@08s10f #250` instead of `08s10f #250`. */
  readonly withHandle?: boolean
  /** Overlay lines every 100 source pixels with coordinates, for orientation. */
  readonly pixelGrid?: boolean
}

/** Labelled frames, up to 12 per sheet, written as `<span>.png` (`<span>.grid.png` with the pixel grid). */
export const sheet = Effect.fn("sheet")(function* (o: SheetOptions): Effect.fn.Return<ViewResult, KymoError> {
  const { timeline } = o.source
  yield* checkFrames(o.source, o.frames)
  const size = yield* frameSize(o.source)
  const withHandle = o.withHandle ?? false
  const labels = o.frames.map((i) => frameLabel(timeline, i, o.labelStyle, withHandle))
  const pages = yield* Effect.fromResult(
    paginate({
      items: o.frames.length,
      frame: size,
      target: o.target,
      labelChars: Math.max(...labels.map((l) => l.length)),
      cursor: o.cursor,
      maxSheets: o.maxSheets
    })
  )
  const destination = {
    view: "sheet",
    outDir: o.outDir,
    fileName: (span: string) => (o.pixelGrid ? `${span}.grid.png` : `${span}.png`)
  } as const
  return yield* writePages(destination, pages, o.frames, (plan, indices) =>
    Effect.map(readFrames(o.source, indices, Math.max(plan.frame.width, plan.frame.height)), (decoded) => ({
      span: spanOf(timeline, indices),
      frames: decoded.map((f) => frameRef(timeline, f)),
      drawing: {
        width: plan.width,
        height: plan.height,
        tiles: decoded.map((f, k) => ({ image: f.image, rect: plan.cells[k]!.frame })),
        overlay: plan.cells
          .map(
            (cell, k) =>
              label(cell.label, frameLabel(timeline, indices[k]!, o.labelStyle, withHandle)) +
              (o.pixelGrid ? pixelGrid(cell.frame, { x: 0, y: 0, ...size }) : "")
          )
          .join("")
      }
    }))
  )
})
