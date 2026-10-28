import type { BackendFailure, FrameRef } from "@kymo/core"
import { type Pages, type SheetPlan, visualTokens } from "@kymo/layout"
import { Effect } from "effect"
import type { ViewImage, ViewName, ViewResult } from "../Output.ts"
import { type Drawing, renderPng } from "./Draw.ts"
import { writeFileAtomic } from "./Files.ts"

/** What a view draws for one page. */
export interface PageDrawing {
  readonly span: string
  readonly drawing: Drawing
  readonly frames: ReadonlyArray<FrameRef>
}

export interface Destination {
  readonly view: ViewName
  readonly outDir: string
  /** File name for a span, e.g. `0f-08s10f.diff.png`. */
  readonly fileName: (span: string) => string
}

/** Render one drawing and write it where its span says. */
export const writeImage = Effect.fnUntraced(function* (to: Destination, page: PageDrawing) {
  const bytes = yield* renderPng(page.drawing)
  const path = yield* writeFileAtomic(to.outDir, to.fileName(page.span), bytes)
  const image: ViewImage = {
    view: to.view,
    span: page.span,
    path,
    width: page.drawing.width,
    height: page.drawing.height,
    tokens: visualTokens(page.drawing.width, page.drawing.height),
    frames: page.frames
  }
  return image
})

/** Draw and write every planned page in order, one page's frames in memory at a time. */
export const writePages = <I, E>(
  to: Destination,
  pages: Pages,
  items: ReadonlyArray<I>,
  draw: (plan: SheetPlan, items: ReadonlyArray<I>) => Effect.Effect<PageDrawing, E>
): Effect.Effect<ViewResult, E | BackendFailure> =>
  Effect.map(
    Effect.forEach(pages.pages, (page) =>
      Effect.flatMap(draw(page.plan, items.slice(page.offset, page.offset + page.count)), (drawn) =>
        writeImage(to, drawn)
      )
    ),
    (images) => ({ images, next: pages.next ?? null })
  )
