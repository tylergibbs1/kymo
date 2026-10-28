import {
  EasingFit,
  type FrameRange,
  LostReason,
  type Precision,
  type RegionTrack,
  fitEasing,
  keyframeIndices,
  knownSamples
} from "@kymo/analysis"
import {
  Address,
  FrameIndex,
  InvalidInput,
  type KymoError,
  type Source,
  type Track,
  secondsAt
} from "@kymo/core"
import { Workspace } from "@kymo/sources"
import { plot as plotView } from "@kymo/views"
import { Effect, Result, Schema } from "effect"
import { BoxText, Format, Range, Source as SourceField, TargetInput } from "../Fields.ts"
import { analysisRange } from "../Frames.ts"
import { define } from "../Operation.ts"
import { OutputDir } from "../OutputDir.ts"
import { measureBox } from "../Region.ts"
import { Sheet, sheetOf } from "../Sheets.ts"

const fields = {
  source: SourceField,
  props: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Which values to return. With box: x, y, w, h, confidence (default x, y, confidence). Without: names of the source's own tracks from probe, e.g. box.x (default all)."
    })
  ),
  range: Schema.optionalKey(Range),
  plot: Schema.Boolean.annotate({ description: "Also draw the tracks as a chart image." }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  fitEasing: Schema.Boolean.annotate({
    description:
      "Fit CSS easings (presets, cubic-bezier) and a spring to each moving track, and report the best with its error."
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  format: Format,
  target: TargetInput
}

/** Three shapes: measure a box, follow a DOM selector (web sources), or read the source's own tracks. */
export const TrackInput = Schema.Union([
  Schema.Struct({
    ...fields,
    box: BoxText.annotate({
      description: "Region to follow, as it is at the first frame of the range: x,y,w,h in source pixels."
    })
  }),
  Schema.Struct({
    ...fields,
    select: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "A CSS selector to follow on web sources, e.g. #hero. Other sources take box instead."
    })
  }),
  Schema.Struct(fields)
]).annotate({
  identifier: "TrackInput",
  description:
    "Pass box (measure a region), select (web sources) or neither (the source's own tracks), not two."
})
type TrackInput = typeof TrackInput.Type

const Keyframe = Schema.Struct({ address: Schema.String, index: FrameIndex, value: Schema.Number })

export const TrackSeries = Schema.Struct({
  name: Schema.String,
  unit: Schema.String,
  min: Schema.NullOr(Schema.Number),
  max: Schema.NullOr(Schema.Number),
  keyframes: Schema.Array(Keyframe).annotate({
    description:
      "Turning points, each at its exact frame: the first and last known values, the last frame before it starts moving, the first frame it stops, both ends of a hold, and every local extreme. Empty for confidence, which is summarised by min and lost."
  }),
  samples: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        address: Schema.String,
        index: FrameIndex,
        t: Schema.Number,
        value: Schema.NullOr(Schema.Number)
      })
    ).annotate({
      description:
        "Detailed only: every frame of the range; null where unknown (e.g. the tracked region was lost)."
    })
  )
})
type TrackSeries = typeof TrackSeries.Type

export const TrackOutput = Schema.Struct({
  handle: Schema.String,
  range: Schema.String,
  method: Schema.Literals(["source", "template"]).annotate({
    description:
      "source: the source's own (ground-truth or telemetry) tracks. template: measured by following the box."
  }),
  tracks: Schema.Array(TrackSeries),
  plot: Schema.NullOr(Sheet),
  easing: Schema.Array(EasingFit),
  lost: Schema.Array(
    Schema.Struct({
      range: Schema.String.annotate({ description: "The frames with no position, e.g. 26f..01s15f." }),
      frames: Schema.Int.annotate({ description: "How many frames that is." }),
      reason: LostReason.annotate({
        description:
          "low-confidence: the box no longer matches what it showed at the first frame. edge: the box ran into the frame edge."
      })
    })
  ).annotate({
    description:
      "Where a measured box was lost (its samples are null), in frame order. Empty for source tracks."
  }),
  note: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "TrackOutput" })

const invalid = (message: string, hint: string) => Effect.fail(new InvalidInput({ message, hint }))

/** Measurement noise by unit: a measured wobble below this is not a turning point. */
const NOISE: Readonly<Record<string, number>> = { px: 0.5, "0..1": 0.01, ratio: 0.01 }

const summary = (track: Track, range: FrameRange, method: Measured["method"], role: Role) => {
  const values = knownSamples(track, range).map(([, v]) => v)
  if (values.length === 0) return { min: null, max: null, keyframes: [] }
  const precision: Precision =
    method === "source" ? { _tag: "source" } : { _tag: "measured", noise: NOISE[track.unit] ?? 0 }
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    keyframes:
      role === "confidence"
        ? []
        : keyframeIndices(track, range, precision).map((index) => ({
            address: Address.format(range.rate, index),
            index: FrameIndex.make(index),
            value: track.samples[index]!
          }))
  }
}

const REGION_PROPS = ["x", "y", "w", "h", "confidence"] as const

const CONCISE_NOTE = "Keyframes only; pass format=detailed for every frame."

/** A value track, or the match quality of a measured box (summarised, never keyframed or eased). */
type Role = "value" | "confidence"

interface Measured {
  readonly method: "source" | "template"
  readonly tracks: ReadonlyArray<{ readonly track: Track; readonly role: Role }>
  readonly region?: RegionTrack
}

/** The tracks the caller asked for: measured from a box, or read from the source. */
const measure = (input: TrackInput, source: Source, range: FrameRange): Effect.Effect<Measured, KymoError> =>
  Effect.gen(function* () {
    const { timeline } = source
    if ("select" in input)
      return yield* invalid(
        `select follows DOM elements on web sources; ${timeline.handle} is a ${timeline.kind} source.`,
        "Pass box=x,y,w,h in source pixels instead, e.g. box=120,80,64,64 (use view=grid in frames to find it)."
      )
    if ("box" in input) {
      const region = yield* measureBox(source, range, input.box)
      const byProp = { x: region.x, y: region.y, w: region.w, h: region.h, confidence: region.confidence }
      const wanted = (input.props ?? ["x", "y", "confidence"]).map((p) => p.replace(/^box\./, ""))
      const unknown = wanted.filter((p) => !(REGION_PROPS as ReadonlyArray<string>).includes(p))
      if (unknown.length > 0)
        return yield* invalid(
          `A tracked box has no ${unknown.join(", ")}.`,
          `Pick from ${REGION_PROPS.join(", ")}, e.g. props=["x","y"].`
        )
      return {
        method: "template",
        region,
        tracks: wanted.map((p) => ({
          track: byProp[p as keyof typeof byProp],
          role: p === "confidence" ? ("confidence" as const) : ("value" as const)
        }))
      }
    }
    const names = input.props ?? timeline.tracks.map((t) => t.name)
    if (names.length === 0)
      return yield* invalid(
        `${timeline.handle} has no numeric tracks of its own.`,
        "Measure a region instead: pass box=x,y,w,h in source pixels, e.g. box=120,80,64,64."
      )
    const tracks = yield* Effect.forEach(names, (name) => source.track(name))
    return { method: "source", tracks: tracks.map((track) => ({ track, role: "value" as const })) }
  })

/** What to tell the caller about a lost box: a wrong starting box, or the subject leaving the frame. */
const lostNotes = (input: TrackInput, region: RegionTrack, range: FrameRange, handle: string) => {
  const notes: Array<string> = []
  const [first] = region.lost
  if (first?.reason === "low-confidence" && first.from.index === range.first + 1 && "box" in input) {
    const at = Address.format(range.rate, range.first)
    const [, , w, h] = input.box.split(",").map((p) => p.trim())
    const rangeFlag = input.range === undefined ? "" : ` --range ${input.range}`
    notes.push(
      `Lost the box right after ${at}: the box must be where the subject is at ${at}, the first frame of the range. Look with kymo frames ${handle} --at ${at} --view grid, then pass the box you see there, e.g. kymo track ${handle}${rangeFlag} --box x,y,${w},${h}.`
    )
  }
  const edge = region.lost.filter((l) => l.reason === "edge")
  if (edge.length > 0)
    notes.push(
      `No position in ${edge.map((l) => range.spanText(l.from.index, l.to.index)).join(", ")}: the box reached the frame edge, so part of the subject is outside the frame.`
    )
  return notes
}

export const track = define({
  name: "track",
  title: "Measure motion",
  description:
    "Measure motion as numbers: positions per frame of a region you name with box (template matching), or the source's own tracks (synthetic ground truth, telemetry). Returns keyframes (turning points: where it starts, stops and reverses, at exact frames); pass format=detailed for every frame's sample. Also an optional chart image, an optional easing fit, and where a box was lost. The box must be where the subject is at the first frame of the range. Prefer these numbers over estimating positions from pixels; use check to test them against rules or assertions.",
  cost: "no images unless plot=true; then 1 chart image, ≤4784 visual tokens at high-res",
  examples: [
    { source: "synthetic:ease?easing=ease-out", props: ["box.x"], fitEasing: true },
    { source: "clips/launch.mp4", box: "120,80,64,64", range: "1s..3s", plot: true },
    { source: "clip1", props: ["box.x", "box.y"], format: "detailed" }
  ],
  input: TrackInput,
  output: TrackOutput,
  readOnly: true,
  images: (output) => (output.plot === null ? [] : [output.plot]),
  run: Effect.fn("kymo.track")(function* (input: TrackInput) {
    const workspace = yield* Workspace
    const output = yield* OutputDir
    const source = yield* workspace.open(input.source)
    const { timeline } = source
    const range = yield* analysisRange(timeline, input.range)
    const measured = yield* measure(input, source, range)
    const detailed = input.format === "detailed"
    const series: Array<TrackSeries> = measured.tracks.map(({ track: t, role }) => ({
      name: t.name,
      unit: t.unit,
      ...summary(t, range, measured.method, role),
      ...(detailed
        ? {
            samples: range.indices().map((index) => ({
              address: Address.format(timeline.rate, index),
              index,
              t: secondsAt(timeline.rate, index),
              value: t.samples[index] ?? null
            }))
          }
        : {})
    }))
    const tracks = measured.tracks.map((m) => m.track)
    const local = new Map(tracks.map((t) => [t.name, t]))
    const withTracks: Source = {
      ...source,
      track: (name) => {
        const found = local.get(name)
        return found ? Effect.succeed(found) : source.track(name)
      }
    }
    const plotted = input.plot
      ? yield* plotView({
          source: withTracks,
          tracks: tracks.map((t) => t.name),
          range: { first: range.first, last: range.last },
          outDir: yield* output.dirFor(timeline.handle),
          target: input.target
        })
      : undefined
    const fits = input.fitEasing
      ? measured.tracks
          .filter((m) => m.role === "value")
          .map(({ track: t }) => [t.name, fitEasing(t, range)] as const)
      : []
    const still = fits.filter(([, r]) => Result.isFailure(r)).map(([name]) => name)
    const span = range.spanText(range.first, range.last)
    const notes = [
      ...(measured.region === undefined ? [] : lostNotes(input, measured.region, range, timeline.handle)),
      ...(still.length > 0
        ? [`No easing fit for ${still.join(", ")}: it does not change enough in ${span}.`]
        : []),
      ...(detailed ? [] : [CONCISE_NOTE])
    ]
    return {
      handle: timeline.handle,
      range: range.spanText(range.first, range.last),
      method: measured.method,
      tracks: series,
      plot:
        plotted === undefined
          ? null
          : sheetOf(
              plotted,
              `Plot · ${timeline.handle} · ${span.replace("..", "–")} · ${tracks.map((t) => t.name).join(", ")}`,
              input.format
            ),
      easing: fits.flatMap(([, r]) => (Result.isSuccess(r) ? [r.success] : [])),
      lost: (measured.region?.lost ?? []).map((l) => ({
        range: range.spanText(l.from.index, l.to.index),
        frames: l.to.index - l.from.index + 1,
        reason: l.reason
      })),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {})
    }
  }, Effect.scoped)
})
