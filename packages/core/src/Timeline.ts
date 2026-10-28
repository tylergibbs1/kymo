import { Schema } from "effect"
import { FrameIndex, Rate } from "./Rate.ts"
import type { ResolveContext } from "./Address.ts"

export const SourceKind = Schema.Literals([
  "video",
  "synthetic",
  "image-seq",
  "web",
  "telemetry",
  "live",
  "remotion",
  "lottie"
])
export type SourceKind = typeof SourceKind.Type

export const Size = Schema.Struct({ width: Schema.Int, height: Schema.Int })
export type Size = typeof Size.Type

/** Marker names must be addressable as `@name+2f`, so `-` and `+` are not allowed. */
export const MarkerName = Schema.String.check(Schema.isPattern(/^[A-Za-z_]\w*$/))

/** A named point on the clock: a cut, a motion peak, ground truth, or one the agent set. */
export const Marker = Schema.Struct({
  name: MarkerName,
  index: FrameIndex,
  address: Schema.String,
  origin: Schema.Literals(["cut", "peak", "truth", "agent", "source"])
})
export type Marker = typeof Marker.Type

/** Track metadata, as listed on a Timeline. Samples are fetched with `Source.track`. */
export const TrackInfo = Schema.Struct({ name: Schema.String, unit: Schema.String })
export type TrackInfo = typeof TrackInfo.Type

/** One numeric channel on the Timeline's clock: `samples[i]` is the value at frame i, or null if unknown. */
export const Track = Schema.Struct({
  name: Schema.String,
  unit: Schema.String,
  samples: Schema.Array(Schema.NullOr(Schema.Number))
})
export type Track = typeof Track.Type

export const RateFrom = Schema.Literals(["source", "param", "assumed"]).annotate({
  description:
    "Where the rate came from: source (the file's own timing), param (an ?fps= on the input) or assumed (the source has no timing, so a default was used; pass ?fps= with the capture rate, or every time and duration will be wrong)."
})
export type RateFrom = typeof RateFrom.Type

export const Timeline = Schema.Struct({
  handle: Schema.String,
  kind: SourceKind,
  /** The path, URL or spec this Timeline was opened from. */
  input: Schema.String,
  rate: Rate,
  /** Where `rate` came from: the file itself, an `?fps=` on the input, or a default because the source has none. */
  rateFrom: RateFrom,
  /** Nominal frames per second, `rate.num / rate.den`. */
  fps: Schema.Number,
  frameCount: Schema.Int,
  /** Canonical timecode of the length, e.g. `07s12f`. */
  duration: Schema.String,
  durationSeconds: Schema.Number,
  /** Null for sources without pixels (telemetry). */
  size: Schema.NullOr(Size),
  seekable: Schema.Boolean,
  live: Schema.Boolean,
  /** True when the source has a variable frame rate; `t` then comes from presentation timestamps. */
  vfr: Schema.Boolean,
  tracks: Schema.Array(TrackInfo),
  markers: Schema.Array(Marker)
})
export type Timeline = typeof Timeline.Type

/** A frame reference as it appears in every output: same address in label, JSON and filename. */
export const FrameRef = Schema.Struct({ address: Schema.String, index: FrameIndex, t: Schema.Number })
export type FrameRef = typeof FrameRef.Type

export const resolveContext = (timeline: Timeline): ResolveContext => ({
  handle: timeline.handle,
  kind: timeline.kind,
  rate: timeline.rate,
  first: 0,
  count: timeline.frameCount,
  live: timeline.live,
  markers: timeline.markers
})

/** The `view` input of `kymo frames` / `kymo_frames`. Defined once here so findings can only suggest real views. */
export const FramesView = Schema.Literals(["sheet", "onion", "diff", "follow", "grid"])
export type FramesView = typeof FramesView.Type
