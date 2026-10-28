import { FrameRef } from "@kymo/core"
import { Cursor } from "@kymo/layout"
import { Schema } from "effect"

export const ViewName = Schema.Literals(["sheet", "filmstrip", "onion", "diff", "compare", "follow", "plot"])
export type ViewName = typeof ViewName.Type

/** One PNG a view wrote. `span` names the frames it shows and is the start of its filename. */
export const ViewImage = Schema.Struct({
  view: ViewName,
  span: Schema.String,
  path: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  /** Visual tokens the image costs (⌈w/28⌉·⌈h/28⌉). */
  tokens: Schema.Int,
  /** Size of the encoded file; never more than the target's byte budget. */
  bytes: Schema.Int,
  /** 1-based number of this image among every image of the request, across cursors. */
  sheet: Schema.Int,
  /** Images the whole request takes, across cursors. */
  sheets: Schema.Int,
  frames: Schema.Array(FrameRef)
})
export type ViewImage = typeof ViewImage.Type

/** A paginated view's output: the sheets drawn this call, and a cursor for the rest. */
export const ViewResult = Schema.Struct({
  images: Schema.Array(ViewImage),
  next: Schema.NullOr(Cursor)
})
export type ViewResult = typeof ViewResult.Type
