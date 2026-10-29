import { CHANGED_FRACTION, FrameDifference, NOISE, frameDifferences, isChanged } from "@kymo/analysis"
import { Address, capStep, enforceFrameCap, secondsAt } from "@kymo/core"
import { DEFAULT_MAX_SHEETS } from "@kymo/layout"
import { Workspace } from "@kymo/sources"
import { compare as compareView } from "@kymo/views"
import { Effect, Schema } from "effect"
import { Addresses, Cursor, Format, Source, SteppedRange, TargetInput, Uncapped } from "../Fields.ts"
import { checkSyntax } from "../Frames.ts"
import { FrameLabels } from "../FrameLabels.ts"
import { define, jsonLines } from "../Operation.ts"
import { OutputDir } from "../OutputDir.ts"
import { allPairs, offsetOf, pairTitle, pairWarnings, resolvePairs } from "../Pairs.ts"
import { Sheet, SheetFrame, toSheets } from "../Sheets.ts"

const fields = {
  a: Source.annotate({ description: "The first source (before), e.g. a path or handle." }),
  b: Source.annotate({
    description:
      "The second source (after), compared at the same moments: by index when both run at the same constant rate, else by time. Each source's offset (open --offset) shifts which of its frames shows a moment."
  }),
  view: Schema.Literals(["side", "diff"])
    .annotate({
      description:
        "side (default): A and B next to each other per row, each labelled with its own address (clip1@… / clip2@…). diff: one |A − B| heatmap per frame (black = identical)."
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed("side" as const))),
  target: TargetInput,
  format: Format,
  uncapped: Uncapped.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  cursor: Schema.optionalKey(Cursor)
}

/** `at` and `range` are two shapes of one input; passing both is rejected by the Schema itself. */
export const CompareInput = Schema.Union([
  Schema.Struct({
    ...fields,
    at: Addresses.annotate({
      description:
        'Addresses on A\'s clock, e.g. ["0f", "1s", "-1f"]; prefix one with B\'s handle (clip2@20s) to read it on B\'s clock. Each is matched to the other source\'s frame at the same time.'
    })
  }),
  Schema.Struct({
    ...fields,
    range: Schema.optionalKey(
      SteppedRange.annotate({
        description:
          "A range like 0f..-1f:10f on A's clock (or B's, prefixed clip2@…). Default: every frame of A that B also has."
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
  offsets: Schema.Struct({ a: Schema.Int, b: Schema.Int }).annotate({
    description:
      "The offsets applied (open --offset): frames each source runs late. A's frame i was paired with B's frame i − offsets.a + offsets.b."
  }),
  frames: Schema.Array(SheetFrame).annotate({ description: "A's frame of each pair, in order." }),
  bFrames: Schema.Array(SheetFrame).annotate({
    description: "B's frame of each pair, in B's own addresses; bFrames[k] shows the moment of frames[k]."
  }),
  sheets: Schema.Array(Sheet),
  changes: Schema.Array(FrameDifference).annotate({
    description:
      "Per pair: how different A and B look. Every requested frame, not just this page. Read changedFraction for small changes; meanDiff averages them away."
  }),
  summary: Schema.Struct({
    mean: Schema.Number.annotate({ description: "Mean of meanDiff over the pairs, 0..1." }),
    max: Schema.Number.annotate({ description: "Largest meanDiff, 0..1." }),
    maxAt: Schema.String.annotate({ description: "A's address of max." }),
    changed: Schema.Int.annotate({
      description: `Pairs where more than ${CHANGED_FRACTION * 100}% of pixels differ by more than ${NOISE} luma (beyond encoding noise), whatever the frame size.`
    })
  }),
  warnings: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Why the comparison may mislead: different clocks, sizes or aspect ratios, or frames of A that B has no frame for (after offsets) and were left out."
    })
  ),
  next: Schema.NullOr(Cursor),
  note: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "CompareOutput" })

export const compare = define({
  name: "compare",
  title: "Compare two sources",
  description:
    "Compare two sources (before/after renders, two encodes) at the same moments: paired sheets, each side labelled with its own address, and a per-pair change summary. Sources at different frame rates are matched by time. Use it to prove a change; use frames to look at one source.",
  cost: `2 cells per frame (side) or 1 (diff), ≤${DEFAULT_MAX_SHEETS} images per call (continue with cursor), ≤4784 visual tokens each at high-res (≤1568 at standard)`,
  examples: [
    { a: "synthetic:ease?easing=linear", b: "synthetic:ease?easing=ease-out", range: "0f..-1f:10f" },
    { a: "renders/before.mp4", b: "renders/after.mp4", at: ["1s", "2s", "3s"], view: "diff" },
    { a: "clip1", b: "clip2", at: ["@impact1", "clip2@4s"], target: "standard" }
  ],
  input: CompareInput,
  output: CompareOutput,
  readOnly: true,
  images: (output) => output.sheets,
  lines: jsonLines(CompareOutput, "sheets"),
  run: Effect.fn("kymo.compare")(function* (input: typeof CompareInput.Type) {
    yield* checkSyntax("at" in input ? input.at : input.range === undefined ? [] : [input.range])
    const workspace = yield* Workspace
    const output = yield* OutputDir
    const { style } = yield* FrameLabels
    const a = yield* workspace.open(input.a)
    const b = yield* workspace.open(input.b)
    const ta = a.timeline
    const tb = b.timeline
    const { pairs, left } =
      "at" in input
        ? { pairs: yield* resolvePairs(ta, tb, input.at), left: undefined }
        : input.range !== undefined
          ? { pairs: yield* resolvePairs(ta, tb, [input.range]), left: undefined }
          : yield* allPairs(ta, tb)
    yield* enforceFrameCap(
      pairs.length,
      input.uncapped,
      `Thin it with a step, e.g. range=0f..-1f:${capStep(pairs.length)}f, or pass fewer addresses in at.`
    )
    const result = yield* compareView({
      a,
      b,
      pairs,
      mode: input.view === "side" ? "side-by-side" : "diff",
      floor: Math.round(NOISE * 255),
      outDir: yield* output.dirFor(ta.handle),
      target: input.target,
      labelStyle: style,
      cursor: input.cursor
    })
    const changes = yield* frameDifferences(a, b, pairs)
    const worst = changes.reduce((m, c) => (c.meanDiff > m.meanDiff ? c : m), changes[0]!)
    const mean = changes.reduce((s, c) => s + c.meanDiff, 0) / changes.length
    const detailed = input.format === "detailed"
    const shown = result.images.reduce((n, image) => n + image.frames.length, 0)
    const ref = (rate: typeof ta.rate, index: (typeof pairs)[number]["a"]) => {
      const address = Address.format(rate, index)
      return detailed ? { address, index, t: secondsAt(rate, index) } : { address, index }
    }
    const warnings = [...pairWarnings(ta, tb), ...(left === undefined ? [] : [left])]
    return {
      a: ta.handle,
      b: tb.handle,
      view: input.view,
      offsets: { a: offsetOf(ta), b: offsetOf(tb) },
      frames: pairs.map((p) => ref(ta.rate, p.a)),
      bFrames: pairs.map((p) => ref(tb.rate, p.b)),
      sheets: toSheets(result.images, {
        timeline: ta,
        who: pairTitle(ta, tb),
        ...(input.view === "diff" ? { view: "diff" } : {}),
        format: input.format,
        labelStyle: style
      }),
      changes,
      summary: {
        mean: Math.round(mean * 1e6) / 1e6,
        max: worst.meanDiff,
        maxAt: worst.address,
        changed: changes.filter(isChanged).length
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      next: result.next,
      ...(result.next === null
        ? {}
        : { note: `Showing ${shown} of ${pairs.length} frames. Pass cursor=${result.next} for the rest.` })
    }
  }, Effect.scoped)
})
