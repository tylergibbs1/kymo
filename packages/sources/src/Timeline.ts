import {
  Address,
  InvalidInput,
  type Marker,
  type Rate,
  type Size,
  type Timeline,
  type Track,
  fpsOf,
  frameIndex
} from "@kymo/core"
import { Effect } from "effect"

export interface TimelineFields {
  readonly handle: string
  readonly kind: Timeline["kind"]
  readonly input: string
  readonly rate: Rate
  readonly frameCount: number
  readonly size: Size
  /** Set when frame times come from presentation timestamps rather than `rate`. */
  readonly vfrDurationSeconds?: number
  readonly tracks?: ReadonlyArray<Track>
  readonly markers?: ReadonlyArray<Marker>
}

/** Every adapter builds its Timeline here, so the derived fields (fps, duration) can't disagree. */
export const makeTimeline = (f: TimelineFields): Timeline => ({
  handle: f.handle,
  kind: f.kind,
  input: f.input,
  rate: f.rate,
  fps: fpsOf(f.rate),
  frameCount: f.frameCount,
  duration: Address.format(f.rate, f.frameCount),
  durationSeconds: f.vfrDurationSeconds ?? (f.frameCount * f.rate.den) / f.rate.num,
  size: f.size,
  seekable: true,
  live: false,
  vfr: f.vfrDurationSeconds !== undefined,
  tracks: (f.tracks ?? []).map(({ name, unit }) => ({ name, unit })),
  markers: f.markers ?? []
})

export const makeMarker = (rate: Rate, name: string, index: number, origin: Marker["origin"]): Marker => ({
  name,
  index: frameIndex(index),
  address: Address.format(rate, index),
  origin
})

/** `Source.track` over a fixed set of tracks. */
export const trackLookup =
  (handle: string, tracks: ReadonlyArray<Track>) =>
  (name: string): Effect.Effect<Track, InvalidInput> => {
    const found = tracks.find((t) => t.name === name)
    if (found) return Effect.succeed(found)
    return Effect.fail(
      new InvalidInput({
        message: `${handle} has no track "${name}".`,
        hint:
          tracks.length > 0
            ? `Tracks: ${tracks.map((t) => t.name).join(", ")}.`
            : `${handle} has no numeric tracks; measure motion from its frames instead.`
      })
    )
  }
