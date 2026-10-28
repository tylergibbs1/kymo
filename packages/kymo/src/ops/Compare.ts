import { FrameDifference, frameDifferences } from "@kymo/analysis"
import { Address, enforceFrameCap, frameIndex, secondsAt } from "@kymo/core"
import { DEFAULT_MAX_SHEETS } from "@kymo/layout"
import { Workspace } from "@kymo/sources"
import { compare as compareView } from "@kymo/views"
import { Effect, Schema } from "effect"
import { Addresses, Cursor, Format, Source, SteppedRange, TargetInput, Uncapped } from "../Fields.ts"
import { resolveAddresses, resolveSpan } from "../Frames.ts"
import { FrameLabels } from "../FrameLabels.ts"
import { define } from "../Operation.ts"
import { OutputDir } from "../OutputDir.ts"
import { Sheet, SheetFrame, toSheets } from "../Sheets.ts"

const fields = {
  a: Source.annotate({ description: "The first source (before), e.g. a path or handle." }),
  b: Source.annotate({ description: "The second source (after), compared at the same addresses." }),
  view: Schema.Literals(["side", "diff"])
    .annotate({
      description:
        "side (default): A and B next to each other per row, labelled clip1@… / clip2@…. diff: one |A − B| heatmap per frame (black = identical)."
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed("side" as const))),
  target: TargetInput,
  format: Format,
  uncapped: Uncapped.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  cursor: Schema.optionalKey(Cursor)
}

/** `at` and `range` are two shapes of one input; passing both is rejected by the Schema itself. */
export const CompareInput = Schema.Union([
  Schema.Struct({ ...fields, at: Addresses }),
  Schema.Struct({
    ...fields,
    range: Schema.optionalKey(
      SteppedRange.annotate({
        description: "A range like 0f..-1f:10f. Default: every frame both sources have."
      })
    )
  })
]).annotate({
  identifier: "CompareInput",
  description: "Pass `at` (a list of addresses) or `range`, not both."
})

export const CompareOutput = Schema.Struct({
  a: Schema.String,
  b: Schema.String,
  view: Schema.Literals(["side", "diff"]),
  frames: Schema.Array(SheetFrame),
  sheets: Schema.Array(Sheet),
  /** Per address: how different A and B look, 0 (identical) to 1. Every requested frame, not just this page. */
  changes: Schema.Array(FrameDifference),
  summary: Schema.Struct({
    mean: Schema.Number,
    max: Schema.Number,
    maxAt: Schema.String,
    /** Frames whose mean difference is above 0.01. */
    changed: Schema.Int
  }),
  next: Schema.NullOr(Cursor),
  note: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "CompareOutput" })

/** Below this a frame counts as unchanged (encoding noise). */
const CHANGED = 0.01

export const compare = define({
  name: "compare",
  title: "Compare two sources",
  description:
    "Compare two sources (before/after renders, two encodes) at the same addresses: paired sheets with matching labels and a per-address change summary. Use it to prove a change; use frames to look at one source. Both sources must have the frames asked for.",
  cost: `2 cells per frame (side) or 1 (diff), ≤${DEFAULT_MAX_SHEETS} images per call (continue with cursor), ≤4784 visual tokens each at high-res (≤1568 at standard)`,
  examples: [
    { a: "synthetic:ease?easing=linear", b: "synthetic:ease?easing=ease-out", range: "0f..-1f:10f" },
    { a: "renders/before.mp4", b: "renders/after.mp4", at: ["1s", "2s", "3s"], view: "diff" },
    { a: "clip1", b: "clip2", at: ["@impact1"], target: "standard" }
  ],
  input: CompareInput,
  output: CompareOutput,
  readOnly: true,
  images: (output) => output.sheets,
  lines: "sheets",
  run: Effect.fn("kymo.compare")(function* (input: typeof CompareInput.Type) {
    const workspace = yield* Workspace
    const output = yield* OutputDir
    const { style } = yield* FrameLabels
    const a = yield* workspace.open(input.a)
    const b = yield* workspace.open(input.b)
    const ta = a.timeline
    const indices =
      "at" in input
        ? yield* resolveAddresses(ta, input.at)
        : input.range !== undefined
          ? yield* resolveSpan(ta, input.range)
          : Array.from({ length: Math.min(ta.frameCount, b.timeline.frameCount) }, (_, i) => frameIndex(i))
    yield* enforceFrameCap(indices.length, input.uncapped)
    const result = yield* compareView({
      a,
      b,
      frames: indices,
      mode: input.view === "side" ? "side-by-side" : "diff",
      outDir: yield* output.dirFor(ta.handle),
      target: input.target,
      labelStyle: style,
      cursor: input.cursor
    })
    const changes = yield* frameDifferences(a, b, indices)
    const worst = changes.reduce((m, c) => (c.meanDiff > m.meanDiff ? c : m), changes[0]!)
    const mean = changes.reduce((s, c) => s + c.meanDiff, 0) / changes.length
    const detailed = input.format === "detailed"
    const shown = result.images.reduce((n, image) => n + image.frames.length, 0)
    return {
      a: ta.handle,
      b: b.timeline.handle,
      view: input.view,
      frames: indices.map((index) => {
        const address = Address.format(ta.rate, index)
        return detailed ? { address, index, t: secondsAt(ta.rate, index) } : { address, index }
      }),
      sheets: toSheets(result.images, {
        timeline: ta,
        who: `${ta.handle} vs ${b.timeline.handle}`,
        ...(input.view === "diff" ? { view: "diff" } : {}),
        more: result.next !== null,
        format: input.format,
        labelStyle: style
      }),
      changes,
      summary: {
        mean: Math.round(mean * 1e6) / 1e6,
        max: worst.meanDiff,
        maxAt: worst.address,
        changed: changes.filter((c) => c.meanDiff > CHANGED).length
      },
      next: result.next,
      ...(result.next === null
        ? {}
        : { note: `Showing ${shown} of ${indices.length} frames. Pass cursor=${result.next} for the rest.` })
    }
  }, Effect.scoped)
})
