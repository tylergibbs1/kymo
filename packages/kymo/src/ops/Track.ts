import { EasingFit, type FrameRange, fitEasing, parseBox, trackRegion } from "@kymo/analysis"
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
  /** Turning points: the first and last known values, where it starts or stops moving, and where it reverses. */
  keyframes: Schema.Array(Keyframe),
  /** Detailed only: every frame of the range; null where unknown (e.g. the tracked region was lost). */
  samples: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        address: Schema.String,
        index: FrameIndex,
        t: Schema.Number,
        value: Schema.NullOr(Schema.Number)
      })
    )
  )
})
type TrackSeries = typeof TrackSeries.Type

export const TrackOutput = Schema.Struct({
  handle: Schema.String,
  range: Schema.String,
  /** source: the source's own (ground-truth or telemetry) tracks. template: measured by following the box. */
  method: Schema.Literals(["source", "template"]),
  tracks: Schema.Array(TrackSeries),
  plot: Schema.NullOr(Sheet),
  easing: Schema.Array(EasingFit),
  note: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "TrackOutput" })

const invalid = (message: string, hint: string) => Effect.fail(new InvalidInput({ message, hint }))

/** A change smaller than this fraction of the track's span counts as standing still... */
const STILL = 0.005
/** ...as does one below the measurement noise of its unit (sub-pixel jitter is not a turning point). */
const NOISE: Readonly<Record<string, number>> = { px: 0.5, "0..1": 0.01, ratio: 0.01 }

const keyframes = (track: Track, range: FrameRange) => {
  const known: Array<readonly [number, number]> = []
  for (let i = range.first; i <= range.last; i++) {
    const v = track.samples[i]
    if (v !== null && v !== undefined) known.push([i, v])
  }
  if (known.length === 0) return { min: null, max: null, keyframes: [] }
  const values = known.map(([, v]) => v)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const eps = Math.max(STILL * (max - min), NOISE[track.unit] ?? 0)
  const dir = (k: number) => {
    const d = known[k + 1]![1] - known[k]![1]
    return Math.abs(d) <= eps ? 0 : Math.sign(d)
  }
  const turns = [0]
  for (let k = 1; k < known.length - 1; k++) if (dir(k - 1) !== dir(k)) turns.push(k)
  if (known.length > 1) turns.push(known.length - 1)
  return {
    min,
    max,
    keyframes: turns.map((k) => {
      const [index, value] = known[k]!
      return { address: Address.format(range.rate, index), index: FrameIndex.make(index), value }
    })
  }
}

const REGION_PROPS = ["x", "y", "w", "h", "confidence"] as const

interface Measured {
  readonly method: "source" | "template"
  readonly tracks: ReadonlyArray<Track>
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
      if (timeline.size === null)
        return yield* invalid(`${timeline.handle} has no pixels to track.`, "Read its own tracks: drop box.")
      const box = yield* Effect.fromResult(parseBox(input.box, timeline.size))
      const region = yield* trackRegion(source, range, box)
      const byProp = { x: region.x, y: region.y, w: region.w, h: region.h, confidence: region.confidence }
      const wanted = (input.props ?? ["x", "y", "confidence"]).map((p) => p.replace(/^box\./, ""))
      const unknown = wanted.filter((p) => !(REGION_PROPS as ReadonlyArray<string>).includes(p))
      if (unknown.length > 0)
        return yield* invalid(
          `A tracked box has no ${unknown.join(", ")}.`,
          `Pick from ${REGION_PROPS.join(", ")}, e.g. props=["x","y"].`
        )
      return { method: "template", tracks: wanted.map((p) => byProp[p as keyof typeof byProp]) }
    }
    const names = input.props ?? timeline.tracks.map((t) => t.name)
    if (names.length === 0)
      return yield* invalid(
        `${timeline.handle} has no numeric tracks of its own.`,
        "Measure a region instead: pass box=x,y,w,h in source pixels, e.g. box=120,80,64,64."
      )
    return { method: "source", tracks: yield* Effect.forEach(names, (name) => source.track(name)) }
  })

export const track = define({
  name: "track",
  title: "Measure motion",
  description:
    "Measure motion as numbers: positions per frame of a region you name with box (template matching), or the source's own tracks (synthetic ground truth, telemetry). Returns keyframes (turning points) or every sample, an optional chart image and an optional easing fit. Prefer these numbers over estimating positions from pixels; use check to test them against rules or assertions.",
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
    const series: Array<TrackSeries> = measured.tracks.map((t) => ({
      name: t.name,
      unit: t.unit,
      ...keyframes(t, range),
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
    const local = new Map(measured.tracks.map((t) => [t.name, t]))
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
          tracks: measured.tracks.map((t) => t.name),
          range: { first: range.first, last: range.last },
          outDir: yield* output.dirFor(timeline.handle),
          target: input.target
        })
      : undefined
    const fits = input.fitEasing
      ? measured.tracks
          .filter((t) => !t.name.endsWith(".confidence"))
          .map((t) => [t.name, fitEasing(t, range)] as const)
      : []
    const still = fits.filter(([, r]) => Result.isFailure(r)).map(([name]) => name)
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
              `Plot · ${timeline.handle} · ${range.spanText(range.first, range.last).replace("..", "–")} · ${measured.tracks.map((t) => t.name).join(", ")}`,
              input.format
            ),
      easing: fits.flatMap(([, r]) => (Result.isSuccess(r) ? [r.success] : [])),
      ...(still.length > 0
        ? {
            note: `No easing fit for ${still.join(", ")}: it does not change enough in ${range.spanText(range.first, range.last)}.`
          }
        : {})
    }
  }, Effect.scoped)
})
