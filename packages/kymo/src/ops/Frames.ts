import {
  type Box,
  type FrameChange,
  VISIBLE_STEP,
  pairChanges,
  parseBox,
  referenceChanges
} from "@kymo/analysis"
import { boxOn } from "../Region.ts"
import {
  Address,
  FrameIndex,
  FramesView,
  InvalidInput,
  type KymoError,
  Marker,
  FRAME_CAP,
  NUMBERS_CAP,
  type Source,
  type Timeline,
  capStep,
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
  Address as AddressField,
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
import { define, jsonLines, optionHint } from "../Operation.ts"
import { OutputDir } from "../OutputDir.ts"
import { Sheet, SheetFrame, sheetOf, toSheets } from "../Sheets.ts"

const fields = {
  source: SourceField,
  view: FramesView.annotate({
    description:
      "sheet (default): the frames side by side, labelled. onion: 3–16 frames blended into one image to show path and spacing. diff: what changed since each frame's previous frame (or since against), on a fixed scale (black = no change beyond the clip's noise), with each frame's changed fraction in diff. follow: crop `box` from every frame. grid: a sheet with source-pixel coordinates drawn on, for orientation only."
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed("sheet" as const))),
  target: TargetInput,
  format: Format,
  box: Schema.optionalKey(
    BoxText.annotate({
      description:
        "For view=follow: the region to crop. For view=diff: the region the numbers in diff are measured in (default the whole frame). x,y,w,h in source pixels."
    })
  ),
  against: Schema.optionalKey(
    AddressField.annotate({
      description:
        "For view=diff: one frame to compare every frame with, instead of the frame before it, e.g. -1f (the last frame) or 0f. Each frame's heatmap and numbers in diff are then its difference from this frame, so the first frame with changedFraction 0 against -1f is where the picture reaches its final look."
    })
  ),
  numbersOnly: Schema.Boolean.annotate({
    description: `For view=diff: return the numbers in diff for every frame and draw no images, so the ${FRAME_CAP}-frame image cap does not apply (numbers stop at ${NUMBERS_CAP} frames unless uncapped).`
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
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
  values: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)).annotate({
    description: "Track name → value at this frame (null where unknown)."
  })
})

export const DiffFrame = Schema.Struct({
  address: Schema.String.annotate({ description: "Frame N, compared with N-1, or with against." }),
  index: FrameIndex,
  changedFraction: Schema.Number.annotate({
    description:
      "Fraction of the pixels (inside box, or of the whole frame) that differ from N-1 (or from against) beyond floor, 0..1. 0 means no visible difference."
  }),
  changedMean: Schema.Number.annotate({
    description: "Mean luma change of those pixels, 0..1; 0 when none changed."
  })
})

export const DiffNumbers = Schema.Struct({
  against: Schema.NullOr(Schema.String).annotate({
    description:
      "The frame every frame was compared with; null when each was compared with the one before it."
  }),
  box: Schema.NullOr(Schema.String).annotate({
    description: "The region measured, x,y,w,h in source pixels; null for the whole frame."
  }),
  floor: Schema.Number.annotate({
    description:
      "Luma steps (0..255) a pixel had to change by to count, and below which the heatmap is black: 5 (2% of full scale), or these frames' own noise when that is larger."
  }),
  frames: Schema.Array(DiffFrame).annotate({
    description:
      "One per diffed frame, in order. A diff at N compares N with N-1, so the frame where something reaches its final state is the last one with a non-zero changedFraction; against -1f, it is the first frame from which every changedFraction is 0."
  })
})

export const FramesOutput = Schema.Struct({
  handle: Schema.String,
  view: FramesView,
  frames: Schema.Array(SheetFrame).annotate({ description: "Every frame requested, in time order." }),
  sheets: Schema.Array(Sheet),
  markers: Schema.optionalKey(
    Schema.Array(Marker).annotate({ description: "Detailed only: markers within the requested frames." })
  ),
  samples: Schema.optionalKey(
    Schema.Array(FrameValues).annotate({
      description: "Detailed only: the source's numeric tracks at each requested frame."
    })
  ),
  diff: Schema.optionalKey(
    DiffNumbers.annotate({
      description: "view=diff only: how much each frame changed, measured, not eyeballed."
    })
  ),
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
  /** view=diff: levels of change drawn black (the noise floor the numbers use too). */
  readonly floor: number
  /** view=diff: the frame every frame is compared with, instead of the one before it. */
  readonly against: FrameIndex | undefined
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
      return diff({ ...common, floor: d.floor, against: d.against })
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

const viewLabel = (input: FramesInput, floor: number, against: string | undefined): string | undefined =>
  input.view === "sheet"
    ? undefined
    : input.view === "follow"
      ? `follow ${input.box}`
      : input.view === "diff"
        ? `${against === undefined ? "diff of each frame with the one before" : `diff against ${against}`}, black under ${floor} luma steps, white a full-scale change`
        : input.view

/** The one frame `against` names. */
const oneFrame = (timeline: Timeline, text: string): Effect.Effect<FrameIndex, KymoError> =>
  Effect.flatMap(resolveAddresses(timeline, [text]), (found) =>
    found.length === 1
      ? Effect.succeed(found[0]!)
      : invalid(
          `against names ${found.length} frames (${text}); a diff is against one frame.`,
          `Pass one address, e.g. ${optionHint(fields, "against", "-1f")} for the last frame.`
        )
  )

/** The whole frame as a box, for diff numbers without one. */
const wholeFrame = (source: Source): Box | undefined =>
  source.timeline.size === null
    ? undefined
    : { x: 0, y: 0, w: source.timeline.size.width, h: source.timeline.size.height }

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
  lines: jsonLines(FramesOutput, "sheets"),
  run: Effect.fn("kymo.frames")(function* (input: FramesInput) {
    if (input.view === "follow" && input.box === undefined)
      return yield* invalid(
        "view=follow needs a box to follow.",
        "Pass box=x,y,w,h in source pixels, e.g. box=120,80,64,64."
      )
    if (input.view !== "follow" && input.view !== "diff" && input.box !== undefined)
      return yield* invalid(
        `box is only used by view=follow and view=diff, not view=${input.view}.`,
        "Pass view=follow or view=diff, or drop box."
      )
    for (const key of ["against", "numbersOnly"] as const)
      if (input.view !== "diff" && input[key] !== undefined && input[key] !== false)
        return yield* invalid(
          `${key} is only used by view=diff, not view=${input.view}.`,
          `Pass ${optionHint(fields, "view", "diff")}, or drop ${key}.`
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
    const span = Address.styledSpan(timeline.rate, indices[0]!, indices[indices.length - 1]!, style)
    yield* input.numbersOnly
      ? enforceFrameCap(
          indices.length,
          input.uncapped,
          `Narrow the range, or thin it with a step, e.g. range=${span}:${Math.max(2, Math.ceil(indices.length / NUMBERS_CAP))}f.`,
          NUMBERS_CAP
        )
      : enforceFrameCap(
          indices.length,
          input.uncapped,
          `Thin it with a step, e.g. range=${span}:${capStep(indices.length)}f, or pass fewer addresses.${input.view === "diff" ? ` For the numbers alone, without images, pass ${optionHint(fields, "numbersOnly", true)}.` : ""}`
        )
    const against = input.against === undefined ? undefined : yield* oneFrame(timeline, input.against)
    // A diff shows each frame against the one before; the first frame has none, so it is skipped.
    const skipFirst = input.view === "diff" && against === undefined && indices[0] === 0 && indices.length > 1
    const drawn = skipFirst ? indices.slice(1) : indices
    const measuredIn =
      input.view !== "diff"
        ? undefined
        : input.box === undefined
          ? wholeFrame(source)
          : yield* boxOn(source, input.box)
    const changes =
      measuredIn === undefined
        ? undefined
        : against === undefined
          ? yield* pairChanges(
              source,
              drawn.filter((i) => i > 0),
              measuredIn
            )
          : yield* referenceChanges(source, drawn, against, measuredIn)
    const floor = changes?.floor ?? VISIBLE_STEP
    const draw: Draw = {
      source,
      outDir: yield* output.dirFor(timeline.handle),
      target: input.target,
      view: input.view,
      box:
        input.view === "follow" && input.box !== undefined ? yield* followBox(source, input.box) : undefined,
      floor,
      against,
      labelStyle: style
    }
    const result: ViewResult = input.numbersOnly
      ? { images: [], next: null }
      : input.separate
        ? yield* drawSeparate(draw, drawn, input.cursor)
        : yield* drawView(draw, drawn, input.cursor)
    const offset = input.cursor === undefined ? 0 : cursorOffset(input.cursor)
    const detailed = input.format === "detailed"
    const refs = indices.map((index) => {
      const address = Address.format(timeline.rate, index)
      return detailed ? { address, index, t: secondsAt(timeline.rate, index) } : { address, index }
    })
    const shown = result.images.reduce((n, image) => n + image.frames.length, 0)
    const againstText = against === undefined ? undefined : Address.styledLabel(timeline.rate, against, style)
    const viewLabelText = viewLabel(input, floor, againstText)
    const sheets = input.separate
      ? result.images.map((image, k) =>
          sheetOf(
            image,
            [
              `Frame ${offset + k + 1} of ${drawn.length}`,
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
          format: input.format,
          labelStyle: style
        })
    const tracks = detailed ? yield* Effect.forEach(timeline.tracks, (t) => source.track(t.name)) : []
    const first = indices[0]!
    const last = indices[indices.length - 1]!
    const notes = [
      ...(skipFirst
        ? [
            `0f has no previous frame to diff against, so the diff starts at ${Address.styledAddress(timeline.rate, drawn[0]!, style)}.`
          ]
        : []),
      ...(result.next === null
        ? []
        : [
            `Showing ${shown} of ${drawn.length} frames. Pass cursor=${result.next} for the rest, or thin the request with a step like range=${Address.styledSpan(timeline.rate, first, last, style, Math.max(2, Math.ceil(indices.length / (DEFAULT_MAX_SHEETS * MAX_PER_SHEET))))}.`
          ])
    ]
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
      ...(changes === undefined
        ? {}
        : {
            diff: {
              against: against === undefined ? null : Address.format(timeline.rate, against),
              box: input.box ?? null,
              floor,
              frames: changes.frames.map((c: FrameChange) => ({
                address: Address.format(timeline.rate, c.index),
                index: c.index,
                changedFraction: c.changedFraction,
                changedMean: c.changedMean
              }))
            }
          }),
      next: result.next,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {})
    }
  }, Effect.scoped)
})
