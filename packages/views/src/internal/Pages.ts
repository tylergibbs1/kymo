import type { BackendFailure, FrameRef } from "@kymo/core"
import { type Pages, type SheetPlan, type Target, targetBudget, visualTokens } from "@kymo/layout"
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
  /** Who will view the image: its byte budget comes from here, so no view can skip it. */
  readonly target: Target
}

/** Where an image sits among every image of its request: sheet 5 of 7. */
export interface Position {
  readonly sheet: number
  readonly sheets: number
}

/** The position of an image that is the whole result. */
export const ONLY: Position = { sheet: 1, sheets: 1 }

/** Render one drawing within the target's byte budget and write it where its span says. */
export const writeImage = Effect.fnUntraced(function* (to: Destination, page: PageDrawing, at: Position) {
  const png = yield* renderPng(page.drawing, targetBudget(to.target).maxBytes)
  const path = yield* writeFileAtomic(to.outDir, to.fileName(page.span), png.bytes)
  const image: ViewImage = {
    view: to.view,
    span: page.span,
    path,
    width: png.width,
    height: png.height,
    tokens: visualTokens(png.width, png.height),
    bytes: png.bytes.length,
    sheet: at.sheet,
    sheets: at.sheets,
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
    Effect.forEach(pages.pages, (page, k) =>
      Effect.flatMap(draw(page.plan, items.slice(page.offset, page.offset + page.count)), (drawn) =>
        writeImage(to, drawn, { sheet: pages.first + k, sheets: pages.total })
      )
    ),
    (images) => ({ images, next: pages.next ?? null })
  )
