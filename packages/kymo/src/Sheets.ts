/** The output contract every image-producing operation shares: labelled sheets and truncation notes. */
import { Address, FrameIndex, type Timeline } from "@kymo/core"
import type { ViewImage } from "@kymo/views"
import { Schema } from "effect"
import { basename } from "node:path"
import type { Format } from "./Fields.ts"

export const SheetFrame = Schema.Struct({
  address: Schema.String,
  index: FrameIndex,
  t: Schema.optionalKey(
    Schema.Number.annotate({ description: "Presentation time in seconds. Detailed only." })
  )
})
export type SheetFrame = typeof SheetFrame.Type

/** One image a call produced. `label` is the text that precedes the image wherever it is shown. */
export const Sheet = Schema.Struct({
  label: Schema.String.annotate({
    description:
      "Text that precedes the image, e.g. `Sheet 1 of 2 · clip1 · 0f–08s10f · 12 frames, every 20f`."
  }),
  span: Schema.String.annotate({ description: "Frames the image covers, as in its file name: 0f-08s10f." }),
  path: Schema.String.annotate({ description: "Absolute path of the PNG." }),
  width: Schema.optionalKey(Schema.Int.annotate({ description: "Detailed only: image width in pixels." })),
  height: Schema.optionalKey(Schema.Int.annotate({ description: "Detailed only: image height in pixels." })),
  tokens: Schema.optionalKey(
    Schema.Int.annotate({ description: "Detailed only: the image's cost in visual tokens." })
  ),
  frames: Schema.Array(SheetFrame)
})
export type Sheet = typeof Sheet.Type

/** `0f–08s10f`, or `#0–#250` in index style (en dash: this is prose, file names use a hyphen). */
const spanText = (
  timeline: Timeline,
  frames: ReadonlyArray<{ readonly index: number }>,
  style: Address.LabelStyle
): string => {
  const one = (i: number) => (style === "index" ? `#${i}` : Address.format(timeline.rate, i))
  const first = frames[0]!.index
  const last = frames[frames.length - 1]!.index
  return first === last ? one(first) : `${one(first)}–${one(last)}`
}

/** `12 frames, every 20f`, `12 frames, uneven spacing`, `1 frame`. */
export const frameCountText = (timeline: Timeline, indices: ReadonlyArray<number>): string => {
  if (indices.length === 1) return "1 frame"
  const gaps = new Set(indices.slice(1).map((i, k) => i - indices[k]!))
  const [gap] = [...gaps]
  const spacing =
    gaps.size === 1 && gap !== undefined
      ? gap === 1
        ? "consecutive"
        : `every ${Address.format(timeline.rate, gap)}`
      : "uneven spacing"
  return `${indices.length} frames, ${spacing}`
}

export interface LabelContext {
  readonly timeline: Timeline
  /** Who the sheet shows, e.g. `clip1` or `clip1 vs clip2`. */
  readonly who: string
  /** Shown after `who` when it is not a plain sheet: `diff`, `onion`, `follow 120,80,64,64`. */
  readonly view?: string
  /** Whether more sheets follow (a `next` cursor). */
  readonly more: boolean
  readonly format: Format
  readonly labelStyle: Address.LabelStyle
}

/** A view's PNGs as labelled sheets. */
export const toSheets = (images: ReadonlyArray<ViewImage>, ctx: LabelContext): Array<Sheet> =>
  images.map((image, k) => {
    const of = `Sheet ${k + 1} of ${images.length}${ctx.more ? "+" : ""}`
    const parts = [of, ctx.who, ...(ctx.view ? [ctx.view] : [])]
    const label = [
      ...parts,
      spanText(ctx.timeline, image.frames, ctx.labelStyle),
      frameCountText(
        ctx.timeline,
        image.frames.map((f) => f.index)
      )
    ].join(" · ")
    return sheetOf(image, label, ctx.format)
  })

/** One PNG as a sheet with a given label. */
export const sheetOf = (image: ViewImage, label: string, format: Format): Sheet => {
  const detailed = format === "detailed"
  return {
    label,
    span: basename(image.path, ".png"),
    path: image.path,
    ...(detailed ? { width: image.width, height: image.height, tokens: image.tokens } : {}),
    frames: image.frames.map((f) =>
      detailed ? { address: f.address, index: f.index, t: f.t } : { address: f.address, index: f.index }
    )
  }
}

/** `Showing 12 of 300 frames. Pass range=… or sample=motion to focus.` when a call shows part of a source. */
export const truncationNote = (shown: number, total: number, advice: string): string | undefined =>
  shown < total ? `Showing ${shown} of ${total} frames. ${advice}` : undefined
