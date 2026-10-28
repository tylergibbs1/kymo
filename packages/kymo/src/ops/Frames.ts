import { parseBox } from "@kymo/analysis"
import {
  Address,
  type FrameIndex,
  FramesView,
  InvalidInput,
  type KymoError,
  Marker,
  type Source,
  enforceFrameCap,
  secondsAt
} from "@kymo/core"
import {
  type Cursor as CursorType,
  DEFAULT_MAX_SHEETS,
  MAX_PER_SHEET,
  type Target,
  cursorOffset,
  encodeCursor
} from "@kymo/layout"
import { Workspace } from "@kymo/sources"
import { type FollowBox, type ViewResult, diff, follow, onion, sheet } from "@kymo/views"
import { Effect, Schema } from "effect"
import {
  Addresses,
  BoxText,
  Cursor,
  Format,
  Source as SourceField,
  SteppedRange,
  TargetInput,
  Uncapped
} from "../Fields.ts"
import { checkSyntax, resolveAddresses, resolveSpan } from "../Frames.ts"
import { FrameLabels } from "../FrameLabels.ts"
import { define } from "../Operation.ts"
import { OutputDir } from "../OutputDir.ts"
import { Sheet, SheetFrame, sheetOf, toSheets } from "../Sheets.ts"

const fields = {
  source: SourceField,
  view: FramesView.annotate({
    description:
      "sheet (default): the frames side by side, labelled. onion: 3–16 frames blended into one image to show path and spacing. diff: what changed since each frame's previous frame (black = nothing). follow: crop `box` from every frame. grid: a sheet with source-pixel coordinates drawn on, for orientation only."
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed("sheet" as const))),
  target: TargetInput,
  format: Format,
  box: Schema.optionalKey(
    BoxText.annotate({ description: "For view=follow: the region x,y,w,h in source pixels." })
  ),
  uncapped: Uncapped.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  separate: Schema.Boolean.annotate({
    description:
      "One image per frame, each file named by its address (0f.png, 08s10f.png), instead of sheets."
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  cursor: Schema.optionalKey(Cursor)
}

/** `at` and `range` are two shapes of one input; passing both is rejected by the Schema itself. */
export const FramesInput = Schema.Union([
  Schema.Struct({ ...fields, at: Addresses }),
  Schema.Struct({ ...fields, range: Schema.optionalKey(SteppedRange) })
]).annotate({
  identifier: "FramesInput",
  description: "Pass `at` (a list of addresses) or `range`, not both."
})
type FramesInput = typeof FramesInput.Type

export const FrameValues = Schema.Struct({
  address: Schema.String,
  /** Track name → value at this frame (null where unknown). */
  values: Schema.Record(Schema.String, Schema.NullOr(Schema.Number))
})

export const FramesOutput = Schema.Struct({
  handle: Schema.String,
  view: FramesView,
  /** Every frame requested, in time order. */
  frames: Schema.Array(SheetFrame),
  sheets: Schema.Array(Sheet),
  /** Detailed only: markers within the requested frames. */
  markers: Schema.optionalKey(Schema.Array(Marker)),
  /** Detailed only: the source's numeric tracks at each requested frame. */
  samples: Schema.optionalKey(Schema.Array(FrameValues)),
  next: Schema.NullOr(Cursor),
  note: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "FramesOutput" })

const invalid = (message: string, hint: string) => Effect.fail(new InvalidInput({ message, hint }))

interface Draw {
  readonly source: Source
  readonly outDir: string
  readonly target: Target
  readonly view: FramesView
  readonly box: FollowBox | undefined
  readonly labelStyle: Address.LabelStyle
}

/** One view call over some frames, as a paginated result. */
const drawView = (d: Draw, frames: ReadonlyArray<FrameIndex>, cursor: CursorType | undefined) => {
  const common = {
    source: d.source,
    frames,
    outDir: d.outDir,
    target: d.target,
    labelStyle: d.labelStyle,
    cursor
  }
  switch (d.view) {
    case "sheet":
      return sheet(common)
    case "grid":
      return sheet({ ...common, pixelGrid: true })
    case "diff":
      return diff(common)
    case "onion":
      return Effect.map(
        onion({ source: d.source, frames, outDir: d.outDir, target: d.target, labelStyle: d.labelStyle }),
        (image): ViewResult => ({ images: [image], next: null })
      )
    case "follow":
      return follow({ ...common, box: d.box! })
  }
}

/** One image per frame, `DEFAULT_MAX_SHEETS` per call, continued with a cursor over the frame list. */
const drawSeparate = (d: Draw, frames: ReadonlyArray<FrameIndex>, cursor: CursorType | undefined) =>
  Effect.gen(function* () {
    const offset = cursor === undefined ? 0 : cursorOffset(cursor)
    if (offset >= frames.length)
      return yield* invalid(
        `The cursor points past the end of these ${frames.length} frames.`,
        "Cursors are only valid for the request that returned them."
      )
    const page = frames.slice(offset, offset + DEFAULT_MAX_SHEETS)
    const results = yield* Effect.forEach(page, (frame) => drawView(d, [frame], undefined))
    const end = offset + page.length
    return {
      images: results.flatMap((r) => r.images),
      next: end < frames.length ? encodeCursor(end) : null
    } satisfies ViewResult
  })

const followBox = (source: Source, text: string): Effect.Effect<FollowBox, KymoError> => {
  const size = source.timeline.size
  if (size === null)
    return invalid(
      `${source.timeline.handle} has no pixels to follow.`,
      "Plot its tracks with track instead."
    )
  return Effect.map(Effect.fromResult(parseBox(text, size)), (b) => {
    const x = Math.round(b.x)
    const y = Math.round(b.y)
    return {
      _tag: "Fixed" as const,
      x,
      y,
      width: Math.max(1, Math.min(size.width - x, Math.round(b.w))),
      height: Math.max(1, Math.min(size.height - y, Math.round(b.h)))
    }
  })
}

const viewLabel = (input: FramesInput): string | undefined =>
  input.view === "sheet" ? undefined : input.view === "follow" ? `follow ${input.box}` : input.view

export const frames = define({
  name: "frames",
  title: "Look at frames",
  description:
    "Look at specific frames. Pass `at` (addresses you already know, e.g. from scan, check or a marker) or `range` (with an optional step), and a view: sheet, onion (path and spacing), diff (what changed), follow (one region up close) or grid. Use scan instead when you do not know where to look yet. Requests over 100 frames are refused unless uncapped; thin a range with a step like 0f..-1f:10f.",
  cost: `up to ${MAX_PER_SHEET} frames per sheet, ≤${DEFAULT_MAX_SHEETS} images per call (continue with cursor), ≤4784 visual tokens each at high-res (≤1568 at standard)`,
  examples: [
    { source: "synthetic:bounce?impact=20", at: ["0f", "@impact1", "-1f"] },
    { source: "clip1", range: "15f..25f", view: "onion" },
    {
      source: "clips/launch.mp4",
      range: "2s..4s:5f",
      view: "follow",
      box: "120,80,64,64",
      target: "standard"
    }
  ],
  input: FramesInput,
  output: FramesOutput,
  readOnly: true,
  images: (output) => output.sheets,
  lines: "sheets",
  run: Effect.fn("kymo.frames")(function* (input: FramesInput) {
    if (input.view === "follow" && input.box === undefined)
      return yield* invalid(
        "view=follow needs a box to follow.",
        "Pass box=x,y,w,h in source pixels, e.g. box=120,80,64,64."
      )
    if (input.view !== "follow" && input.box !== undefined)
      return yield* invalid(
        `box is only used by view=follow, not view=${input.view}.`,
        "Pass view=follow, or drop box."
      )
    if (input.separate && input.view === "onion")
      return yield* invalid(
        "An onion blends its frames into one image, so it cannot be separate.",
        "Drop separate, or use view=sheet."
      )
    yield* checkSyntax("at" in input ? input.at : input.range === undefined ? [] : [input.range])
    const workspace = yield* Workspace
    const output = yield* OutputDir
    const { style } = yield* FrameLabels
    const source = yield* workspace.open(input.source)
    const { timeline } = source
    const indices =
      "at" in input ? yield* resolveAddresses(timeline, input.at) : yield* resolveSpan(timeline, input.range)
    yield* enforceFrameCap(indices.length, input.uncapped)
    const draw: Draw = {
      source,
      outDir: yield* output.dirFor(timeline.handle),
      target: input.target,
      view: input.view,
      box: input.box === undefined ? undefined : yield* followBox(source, input.box),
      labelStyle: style
    }
    const result = input.separate
      ? yield* drawSeparate(draw, indices, input.cursor)
      : yield* drawView(draw, indices, input.cursor)
    const detailed = input.format === "detailed"
    const refs = indices.map((index) => {
      const address = Address.format(timeline.rate, index)
      return detailed ? { address, index, t: secondsAt(timeline.rate, index) } : { address, index }
    })
    const shown = result.images.reduce((n, image) => n + image.frames.length, 0)
    const viewLabelText = viewLabel(input)
    const sheets = input.separate
      ? result.images.map((image, k) =>
          sheetOf(
            image,
            [
              `Frame ${k + 1} of ${result.images.length}${result.next === null ? "" : "+"}`,
              timeline.handle,
              ...(viewLabelText ? [viewLabelText] : []),
              Address.styledLabel(timeline.rate, image.frames[0]!.index, style)
            ].join(" · "),
            input.format
          )
        )
      : toSheets(result.images, {
          timeline,
          who: timeline.handle,
          ...(viewLabelText ? { view: viewLabelText } : {}),
          more: result.next !== null,
          format: input.format,
          labelStyle: style
        })
    const tracks = detailed ? yield* Effect.forEach(timeline.tracks, (t) => source.track(t.name)) : []
    const first = indices[0]!
    const last = indices[indices.length - 1]!
    return {
      handle: timeline.handle,
      view: input.view,
      frames: refs,
      sheets,
      ...(detailed
        ? {
            markers: timeline.markers.filter((m) => m.index >= first && m.index <= last),
            ...(tracks.length > 0
              ? {
                  samples: refs.map((r) => ({
                    address: r.address,
                    values: Object.fromEntries(tracks.map((t) => [t.name, t.samples[r.index] ?? null]))
                  }))
                }
              : {})
          }
        : {}),
      next: result.next,
      ...(result.next === null
        ? {}
        : {
            note: `Showing ${shown} of ${indices.length} frames. Pass cursor=${result.next} for the rest, or thin the request with a step like range=${Address.format(timeline.rate, first)}..${Address.format(timeline.rate, last)}:${Math.max(2, Math.ceil(indices.length / (DEFAULT_MAX_SHEETS * MAX_PER_SHEET)))}f.`
          })
    }
  }, Effect.scoped)
})
