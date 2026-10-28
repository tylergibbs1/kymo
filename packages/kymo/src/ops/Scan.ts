import {
  Budget,
  type Cuts,
  type FrameRange,
  type Motion,
  SampleStrategy,
  detectCuts,
  motionEnergy,
  sample,
  scan as scanFrames
} from "@kymo/analysis"
import { FRAME_CAP, frameIndex } from "@kymo/core"
import { DEFAULT_MAX_SHEETS, MAX_PER_SHEET } from "@kymo/layout"
import { Workspace } from "@kymo/sources"
import { sheet } from "@kymo/views"
import { Effect, Schema } from "effect"
import { Cursor, Format, Range, Source, TargetInput } from "../Fields.ts"
import { analysisRange } from "../Frames.ts"
import { FrameLabels } from "../FrameLabels.ts"
import { define } from "../Operation.ts"
import { OutputDir } from "../OutputDir.ts"
import { Sheet, SheetFrame, toSheets, truncationNote } from "../Sheets.ts"

export const ScanInput = Schema.Struct({
  source: Source,
  range: Schema.optionalKey(Range),
  budget: Budget.check(Schema.isLessThanOrEqualTo(FRAME_CAP))
    .annotate({ description: `Frames to show, 1 to ${FRAME_CAP}. Default 12; 6–12 is a good overview.` })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(12))),
  sample: SampleStrategy.annotate({
    description:
      "How to spend the budget: motion (default) puts frames where things change, even spaces them evenly, cuts shows both sides of every cut. First, last and cut frames are always included."
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed("motion" as const))),
  target: TargetInput,
  format: Format,
  cursor: Schema.optionalKey(Cursor)
}).annotate({ identifier: "ScanInput" })

const Peak = Schema.Struct({
  /** `peak1` is the strongest. Saved as a marker, addressable as `@peak1`. */
  name: Schema.String,
  address: Schema.String,
  value: Schema.Number
})
const Window = Schema.Struct({
  range: Schema.String.annotate({ description: "Ready to pass as `range`." }),
  mean: Schema.Number
})

export const ScanCut = Schema.Struct({
  /** `cut1`. Saved as a marker, so later calls can address it as `@cut1` or `@cut1+5f`. */
  name: Schema.String,
  kind: Schema.Literals(["hard", "fade"]),
  address: Schema.String,
  /** Last frame of the outgoing shot and first frame fully in the incoming one. */
  from: Schema.String,
  to: Schema.String,
  score: Schema.Number
})

export const Suggestion = Schema.Struct({
  range: Schema.String.annotate({ description: "Ready to pass as `range` to frames, scan, track or check." }),
  reason: Schema.String
})

export const ScanOutput = Schema.Struct({
  handle: Schema.String,
  /** The range that was scanned. */
  range: Schema.String,
  /** The sampled frames, in time order. */
  frames: Schema.Array(SheetFrame),
  sheets: Schema.Array(Sheet),
  motion: Schema.Struct({
    /** Mean absolute luma change per frame, 0..1. */
    mean: Schema.Number,
    max: Schema.Number,
    maxAt: Schema.String,
    /** Fraction of frames that are still. */
    stillRatio: Schema.Number,
    /** Strongest first. */
    peaks: Schema.Array(Peak),
    /** About one second each, busiest first. */
    windows: Schema.Array(Window),
    /** Detailed only: energy per frame of the range, first frame first. */
    energy: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.Number)))
  }),
  cuts: Schema.Array(ScanCut),
  suggestions: Schema.Array(Suggestion),
  next: Schema.NullOr(Cursor),
  note: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "ScanOutput" })

const MAX_SUGGESTIONS = 4

/** Ranges worth a closer look: around each cut (strongest first), the busiest windows, the top motion peak. */
const suggest = (range: FrameRange, motion: Motion, cuts: Cuts): Array<typeof Suggestion.Type> => {
  const out: Array<{ readonly first: number; readonly last: number; readonly reason: string }> = []
  const add = (first: number, last: number, reason: string) => {
    const a = Math.max(range.first, first)
    const b = Math.min(range.last, last)
    if (b <= a || out.some((s) => a <= s.last && b >= s.first)) return
    out.push({ first: a, last: b, reason })
  }
  const pad = Math.max(2, Math.round(range.rate.num / range.rate.den / 6))
  for (const c of [...cuts.cuts].sort((a, b) => b.score - a.score))
    add(
      c.from.index - pad,
      c.to.index + pad,
      `around ${c.marker.name} (${c.kind} cut at ${c.marker.address})`
    )
  for (const w of motion.windows) add(w.from.index, w.to.index, `busiest motion (mean energy ${w.mean})`)
  const peak = motion.peaks[0]
  if (peak) add(peak.marker.index - pad, peak.marker.index + pad, `around the strongest motion peak`)
  return out
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => ({ range: range.spanText(s.first, s.last), reason: s.reason }))
}

export const scan = define({
  name: "scan",
  title: "Overview of a source",
  description:
    "Get an overview of a source: a small budget of labelled frames chosen where things change, plus a motion-energy summary (mean, peaks, busiest windows), detected cuts and suggested ranges to look at next. Use it before frames when you do not yet know where to look; use frames once you have addresses.",
  cost: `budget frames on sheets of up to ${MAX_PER_SHEET}; ≤${DEFAULT_MAX_SHEETS} images per call, ≤4784 visual tokens each at high-res (≤1568 at standard)`,
  examples: [
    { source: "synthetic:bounce?impact=20", budget: 8 },
    { source: "clips/launch.mp4", range: "2s..6s", sample: "even", target: "standard" },
    { source: "clip1", budget: 6, format: "detailed" }
  ],
  input: ScanInput,
  output: ScanOutput,
  readOnly: true,
  images: (output) => output.sheets,
  run: Effect.fn("kymo.scan")(function* (input: typeof ScanInput.Type) {
    const workspace = yield* Workspace
    const output = yield* OutputDir
    const { style } = yield* FrameLabels
    const source = yield* workspace.open(input.source)
    const { timeline } = source
    const range = yield* analysisRange(timeline, input.range)
    const stats = yield* scanFrames(source, range)
    const cuts = detectCuts(stats)
    const motion = motionEnergy(stats, cuts)
    const picked =
      input.sample === "motion"
        ? sample({ strategy: "motion", scan: stats, cuts, budget: input.budget })
        : input.sample === "cuts"
          ? sample({ strategy: "cuts", range, cuts, budget: input.budget })
          : sample({ strategy: "even", range, budget: input.budget })
    const result = yield* sheet({
      source,
      frames: picked.map((f) => frameIndex(f.index)),
      outDir: yield* output.dirFor(timeline.handle),
      target: input.target,
      labelStyle: style,
      cursor: input.cursor
    })
    for (const m of [...cuts.cuts.map((c) => c.marker), ...motion.peaks.map((p) => p.marker)])
      yield* workspace.addMarker(timeline.handle, m.name, m.index)
    const suggestions = suggest(range, motion, cuts)
    const detailed = input.format === "detailed"
    const focus = suggestions[0]?.range ?? range.spanText(range.first, range.last)
    const notes = [
      truncationNote(
        picked.length,
        range.count,
        input.sample === "motion"
          ? `Pass range=${focus} to focus, or a larger budget.`
          : `Pass range=${focus} or sample=motion to focus.`
      ),
      result.next === null ? undefined : `More sheets follow; pass cursor=${result.next}.`
    ].filter((n) => n !== undefined)
    return {
      handle: timeline.handle,
      range: range.spanText(range.first, range.last),
      frames: picked.map((f) => (detailed ? f : { address: f.address, index: f.index })),
      sheets: toSheets(result.images, {
        timeline,
        who: timeline.handle,
        more: result.next !== null,
        format: input.format,
        labelStyle: style
      }),
      motion: {
        mean: motion.mean,
        max: motion.max,
        maxAt: motion.maxAt.address,
        stillRatio: motion.stillRatio,
        peaks: motion.peaks.map((p) => ({ name: p.marker.name, address: p.marker.address, value: p.value })),
        windows: motion.windows.map((w) => ({ range: w.address, mean: w.mean })),
        ...(detailed ? { energy: motion.track.samples.slice(range.first, range.last + 1) } : {})
      },
      cuts: cuts.cuts.map((c) => ({
        name: c.marker.name,
        kind: c.kind,
        address: c.marker.address,
        from: c.from.address,
        to: c.to.address,
        score: c.score
      })),
      suggestions,
      next: result.next,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {})
    }
  }, Effect.scoped)
})
