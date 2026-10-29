import {
  type BoxChange,
  EasingFit,
  FrameRange,
  LostReason,
  type Precision,
  type RegionTrack,
  Unfit,
  fitEasing,
  keyframeIndices,
  knownSamples,
  unitScale
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
import { analysisRange, resolveAddresses } from "../Frames.ts"
import { define } from "../Operation.ts"
import { OutputDir } from "../OutputDir.ts"
import { measureBox, measureChange } from "../Region.ts"
import { Sheet, sheetOf } from "../Sheets.ts"

const fields = {
  source: SourceField,
  props: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Which values to return. With box: x, y, w, h, confidence, opacity (how much of its contrast at the anchor frame the subject shows, 1 at the anchor: a fade), change (the fraction of the box that visibly changed since the previous frame, with when it starts and settles) (default x, y, confidence). change alone measures the box where it is on screen and does not follow the subject. Without box: names of the source's own tracks from probe, e.g. box.x (default all)."
    })
  ),
  range: Schema.optionalKey(
    Range.annotate({
      description:
        "A contiguous range like 2s..4s, #30..#90 or @cut1..-1f. Default: the whole source. With box, a range written backwards (30f..12f) tracks back in time from its first address, where the box is."
    })
  ),
  anchor: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1)).annotate({
      description:
        "With box: the frame the box describes, e.g. 30f; tracking runs forwards and backwards from it. Default: the first address of range as written. Read the box off the frame where the subject is fully visible."
    })
  ),
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
      description:
        "Region to follow, as it is at the anchor frame (the first address of range unless anchor is given): x,y,w,h in source pixels."
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

const Run = Schema.Struct({
  range: Schema.String.annotate({ description: "The frames, e.g. 13f..29f." }),
  frames: Schema.Int.annotate({ description: "How many frames that is." })
})

export const ChangeSummary = Schema.Struct({
  box: Schema.String.annotate({
    description:
      "The region measured, x,y,w,h in source pixels: the box as given, fixed on screen (it does not follow the subject)."
  }),
  floor: Schema.Number.annotate({
    description:
      "Luma steps (0..255) a pixel had to change by to count: 5 (2% of full scale), or this clip's own noise inside the box when that is larger. An edge also had to move by half a pixel or more."
  }),
  starts: Schema.NullOr(Schema.String).annotate({
    description: "The first frame that visibly differs from the range's first frame; null if none does."
  }),
  settles: Schema.NullOr(Schema.String).annotate({
    description:
      "The first frame from which every frame looks like the range's last frame: where the box reaches its final look. null when the last frame still differs from the one before it (still changing at the end of the range)."
  }),
  changing: Schema.Array(Run).annotate({
    description:
      "Runs of frames that visibly differ from the frame before them, in order. The value at frame N compares N with N-1, so a run's last frame is where that change finished."
  }),
  discounted: Schema.Array(Run).annotate({
    description:
      "Runs of frames where the page around the box dimmed or brightened as a whole (a scrim, a backdrop): that tone change was taken out of the box's change. Empty when the surroundings stayed put."
  })
}).annotate({
  description: "With props change: when the box visibly changes, measured against the clip's noise."
})
type ChangeSummary = typeof ChangeSummary.Type

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
  change: Schema.optionalKey(ChangeSummary),
  easing: Schema.Array(EasingFit).annotate({
    description:
      "One fit per track whose whole motion was seen: each end at a rest, the range bound, or where the subject appeared or disappeared (then that end is estimated; see start and end)."
  }),
  easingSkipped: Schema.optionalKey(
    Schema.Array(Unfit).annotate({
      description:
        "With fitEasing: each track that got no fit, and why: lost, partial (part of the motion not seen), too-few-samples or no-motion."
    })
  ),
  anchor: Schema.optionalKey(
    Schema.String.annotate({ description: "The frame the box describes; tracking runs both ways from it." })
  ),
  lost: Schema.Array(
    Schema.Struct({
      range: Schema.String.annotate({ description: "The frames with no position, e.g. 26f..01s15f." }),
      frames: Schema.Int.annotate({ description: "How many frames that is." }),
      reason: LostReason.annotate({
        description:
          "low-confidence: something is there but it does not match what the box showed at the anchor frame. edge: the subject is past the frame edge, almost entirely outside the frame. faded: nothing like the subject is where it was (it faded out or was hidden)."
      })
    })
  ).annotate({
    description:
      "Where a measured box was lost (its samples are null), in frame order. Empty for source tracks."
  }),
  note: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "TrackOutput" })

const invalid = (message: string, hint: string) => Effect.fail(new InvalidInput({ message, hint }))

const summary = (track: Track, range: FrameRange, method: Measured["method"], role: Role) => {
  const values = knownSamples(track, range).map(([, v]) => v)
  if (values.length === 0) return { min: null, max: null, keyframes: [] }
  const precision: Precision =
    method === "source" ? { _tag: "source" } : { _tag: "measured", noise: unitScale(track.unit).noise }
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    keyframes:
      role !== "value"
        ? []
        : keyframeIndices(track, range, precision).map((index) => ({
            address: Address.format(range.rate, index),
            index: FrameIndex.make(index),
            value: track.samples[index]!
          }))
  }
}

const REGION_PROPS = ["x", "y", "w", "h", "confidence", "opacity", "change"] as const
type RegionProp = (typeof REGION_PROPS)[number]
const isRegionProp = (p: string): p is RegionProp => (REGION_PROPS as ReadonlyArray<string>).includes(p)

/** Measured only inside a box; asked for without one, the hint says how. */
const BOX_ONLY: Readonly<Record<string, string>> = {
  change: 'change is measured inside a box: pass box=x,y,w,h and props=["change"]',
  opacity: 'opacity is measured on a tracked box: pass box=x,y,w,h and props=["opacity"]',
  motion:
    'whole-frame motion energy is scan\'s motion.energy (format=detailed); for change inside a region pass box=x,y,w,h and props=["change"]'
}

const CONCISE_NOTE = "Keyframes only; pass format=detailed for every frame."

/** A value track, or a measured box's match quality or visible change (summarised, never keyframed or eased). */
type Role = "value" | "confidence" | "change"

interface Measured {
  readonly method: "source" | "template"
  readonly tracks: ReadonlyArray<{ readonly track: Track; readonly role: Role }>
  readonly region?: RegionTrack
  readonly change?: BoxChange
}

/** The frames to measure and the frame the box describes. */
interface Frames {
  readonly range: FrameRange
  readonly anchor: number
}

/**
 * The range and anchor. A range written backwards (30f..12f) covers 12f..30f and anchors at 30f, so
 * a box read off the frame where the subject is fully visible can be followed back to where it appears.
 */
const framesOf = (input: TrackInput, timeline: Source["timeline"]): Effect.Effect<Frames, KymoError> =>
  Effect.gen(function* () {
    const text = input.range
    let frames: Frames | undefined
    if (text !== undefined) {
      const address = yield* Address.parseEffect(text)
      const prefix = address.handle === undefined ? "" : `${address.handle}@`
      const ends = text.slice(prefix.length).split("..")
      if (address.spec._tag === "Range" && address.spec.step === undefined && ends.length === 2) {
        const [from] = yield* resolveAddresses(timeline, [prefix + ends[0]!])
        const [to] = yield* resolveAddresses(timeline, [prefix + ends[1]!])
        if (from !== undefined && to !== undefined && to < from)
          frames = { range: yield* FrameRange.parse(timeline, `#${to}..#${from}`), anchor: from }
      }
    }
    if (frames === undefined) {
      const range = yield* analysisRange(timeline, text)
      frames = { range, anchor: range.first }
    }
    if (input.anchor === undefined) return frames
    if (!("box" in input))
      return yield* invalid(
        "anchor says which frame a box describes; this call has no box.",
        "Pass box=x,y,w,h as the subject is at that frame, e.g. box=120,80,64,64 anchor=30f, or drop anchor."
      )
    const at = yield* resolveAddresses(timeline, [input.anchor])
    const { range } = frames
    const span = range.spanText(range.first, range.last)
    if (at.length !== 1 || at[0]! < range.first || at[0]! > range.last)
      return yield* invalid(
        `anchor ${input.anchor} is not one frame inside ${span}.`,
        `Pass one frame inside the range, e.g. anchor=${Address.format(range.rate, range.last)}, or widen the range to include it.`
      )
    return { range, anchor: at[0]! }
  })

/** The tracks the caller asked for: measured from a box, or read from the source. */
const measure = (input: TrackInput, source: Source, frames: Frames): Effect.Effect<Measured, KymoError> =>
  Effect.gen(function* () {
    const { timeline } = source
    if ("select" in input)
      return yield* invalid(
        `select follows DOM elements on web sources; ${timeline.handle} is a ${timeline.kind} source.`,
        "Pass box=x,y,w,h in source pixels instead, e.g. box=120,80,64,64 (use view=grid in frames to find it)."
      )
    if ("box" in input) {
      const asked = (input.props ?? ["x", "y", "confidence"]).map((p) => p.replace(/^box\./, ""))
      const unknown = asked.filter((p) => !isRegionProp(p))
      if (unknown.length > 0)
        return yield* invalid(
          `A tracked box has no ${unknown.join(", ")}.`,
          `Pick from ${REGION_PROPS.join(", ")}, e.g. props=["x","y"].`
        )
      const wanted = asked.filter(isRegionProp)
      // change is a place on screen, not the subject: it needs no tracking of its own.
      const region = wanted.some((p) => p !== "change")
        ? yield* measureBox(source, frames.range, input.box, frames.anchor)
        : undefined
      const change = wanted.includes("change")
        ? yield* measureChange(source, frames.range, input.box)
        : undefined
      const picked = wanted.flatMap((p): Array<{ readonly track: Track; readonly role: Role }> => {
        if (p === "change") return change === undefined ? [] : [{ track: change.track, role: "change" }]
        if (region === undefined) return []
        return [{ track: region[p], role: p === "confidence" ? "confidence" : "value" }]
      })
      return {
        method: "template",
        ...(region === undefined ? {} : { region }),
        ...(change === undefined ? {} : { change }),
        tracks: picked
      }
    }
    const names = input.props ?? timeline.tracks.map((t) => t.name)
    if (names.length === 0)
      return yield* invalid(
        `${timeline.handle} has no numeric tracks of its own.`,
        "Measure a region instead: pass box=x,y,w,h in source pixels, e.g. box=120,80,64,64."
      )
    const own = new Set(timeline.tracks.map((t) => t.name))
    const boxOnly = names.find((n) => !own.has(n) && BOX_ONLY[n] !== undefined)
    if (boxOnly !== undefined)
      return yield* invalid(`${timeline.handle} has no track "${boxOnly}".`, `${BOX_ONLY[boxOnly]}.`)
    const tracks = yield* Effect.forEach(names, (name) => source.track(name))
    return { method: "source", tracks: tracks.map((track) => ({ track, role: "value" as const })) }
  })

/** The change summary as the output shows it. */
const changeSummary = (c: BoxChange, range: FrameRange): ChangeSummary => {
  const runs = (spans: BoxChange["changing"]) =>
    spans.map((s) => ({
      range: range.spanText(s.from.index, s.to.index),
      frames: s.to.index - s.from.index + 1
    }))
  return {
    box: [c.box.x, c.box.y, c.box.w, c.box.h].join(","),
    floor: c.floor,
    starts: c.starts?.address ?? null,
    settles: c.settles?.address ?? null,
    changing: runs(c.changing),
    discounted: runs(c.discounted)
  }
}

/** What to tell the caller about a lost box: a wrong box at the anchor, or the subject leaving or fading. */
const lostNotes = (input: TrackInput, region: RegionTrack, frames: Frames, handle: string) => {
  const { range, anchor } = frames
  const notes: Array<string> = []
  const next = region.lost.find((l) => l.from.index === anchor + 1 || l.to.index === anchor - 1)
  if (next?.reason === "low-confidence" && "box" in input) {
    const at = Address.format(range.rate, anchor)
    const which = anchor === range.first ? "the first frame of the range" : "the anchor frame"
    const [, , w, h] = input.box.split(",").map((p) => p.trim())
    const rangeFlag = input.range === undefined ? "" : ` --range ${input.range}`
    const anchorFlag = input.anchor === undefined ? "" : ` --anchor ${input.anchor}`
    notes.push(
      `Lost the box right next to ${at}: the box must be where the subject is at ${at}, ${which}. Look with kymo frames ${handle} --at ${at} --view grid, then pass the box you see there, e.g. kymo track ${handle}${rangeFlag}${anchorFlag} --box x,y,${w},${h}.`
    )
  }
  const spans = (reason: LostReason) =>
    region.lost
      .filter((l) => l.reason === reason)
      .map((l) => range.spanText(l.from.index, l.to.index))
      .join(", ")
  const edge = spans("edge")
  if (edge !== "")
    notes.push(
      `No position in ${edge}: the subject is past the frame edge there, almost entirely outside the frame.`
    )
  const faded = spans("faded")
  if (faded !== "")
    notes.push(`No position in ${faded}: the subject is not visible there (faded out or hidden).`)
  return notes
}

export const track = define({
  name: "track",
  title: "Measure motion",
  description:
    "Measure motion as numbers: positions per frame of a region you name with box (template matching), its opacity (a fade), and how much of the box visibly changes each frame (props change: when something in it starts and settles, above the clip's encoder noise), or the source's own tracks (synthetic ground truth, telemetry). Returns keyframes (turning points: where it starts, stops and reverses, at exact frames); pass format=detailed for every frame's sample. Also an optional chart image, an optional easing fit (only for a motion seen whole; easingSkipped says why a track has none), and where a box was lost. The box must be where the subject is at the anchor frame: the first address of range, so a range written backwards (30f..12f) follows a box read at 30f back to 12f; or pass anchor. w and h are measured: they follow the subject's scale. Prefer these numbers over estimating positions from pixels; use check to test them against rules or assertions.",
  cost: "no images unless plot=true; then 1 chart image, ≤4784 visual tokens at high-res",
  examples: [
    { source: "synthetic:ease?easing=ease-out", props: ["box.x"], fitEasing: true },
    { source: "clips/launch.mp4", box: "120,80,64,64", range: "1s..3s", plot: true },
    { source: "clips/modal.mp4", box: "400,220,480,280", range: "30f..12f", fitEasing: true },
    { source: "clips/toast.mp4", box: "916,80,340,64", props: ["change"] },
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
    const frames = yield* framesOf(input, timeline)
    const { range } = frames
    const measured = yield* measure(input, source, frames)
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
    const lost = measured.region?.lost ?? []
    const fits = input.fitEasing
      ? measured.tracks.filter((m) => m.role === "value").map(({ track: t }) => fitEasing(t, range, { lost }))
      : []
    const skipped = fits.flatMap((r) => (Result.isFailure(r) ? [r.failure] : []))
    const span = range.spanText(range.first, range.last)
    const notes = [
      ...(measured.region === undefined ? [] : lostNotes(input, measured.region, frames, timeline.handle)),
      ...(measured.change !== undefined && measured.change.settles === undefined
        ? [
            `The box still changes at the last frame, so it has not settled in ${span}; widen the range to see where it settles.`
          ]
        : []),
      ...skipped.map((u) => `No easing fit for ${u.track} (${u.status}): ${u.reason}`),
      ...(detailed ? [] : [CONCISE_NOTE])
    ]
    return {
      handle: timeline.handle,
      range: range.spanText(range.first, range.last),
      method: measured.method,
      tracks: series,
      ...(measured.change === undefined ? {} : { change: changeSummary(measured.change, range) }),
      plot:
        plotted === undefined
          ? null
          : sheetOf(
              plotted,
              `Plot · ${timeline.handle} · ${span.replace("..", "–")} · ${tracks.map((t) => t.name).join(", ")}`,
              input.format
            ),
      easing: fits.flatMap((r) => (Result.isSuccess(r) ? [r.success] : [])),
      ...(input.fitEasing ? { easingSkipped: skipped } : {}),
      ...(measured.region === undefined ? {} : { anchor: Address.format(range.rate, frames.anchor) }),
      lost: lost.map((l) => ({
        range: range.spanText(l.from.index, l.to.index),
        frames: l.to.index - l.from.index + 1,
        reason: l.reason
      })),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {})
    }
  }, Effect.scoped)
})
