import {
  Address,
  InvalidInput,
  type Marker,
  type Rate,
  type RateFrom,
  type Size,
  type Timeline,
  type Track,
  type VariableClock,
  fpsOf,
  frameIndex,
  secondsAt,
  variableRate
} from "@kymo/core"
import { Effect } from "effect"

export interface TimelineFields {
  readonly handle: string
  readonly kind: Timeline["kind"]
  readonly input: string
  readonly rate: Rate
  readonly rateFrom: RateFrom
  readonly frameCount: number
  readonly size: Size
  /** Set when frame times come from presentation timestamps (or GIF delays) rather than `rate`. */
  readonly clock?: VariableClock
  readonly tracks?: ReadonlyArray<Track>
  readonly markers?: ReadonlyArray<Marker>
}

/**
 * Every adapter builds its Timeline here, so the derived fields can't disagree: on a variable clock
 * the rate carries every frame's start time, and duration, addresses and `t` are all read from it.
 */
export const makeTimeline = (f: TimelineFields): Timeline => {
  const rate = f.clock === undefined ? f.rate : variableRate(f.rate, f.clock)
  return {
    handle: f.handle,
    kind: f.kind,
    input: f.input,
    rate,
    rateFrom: f.rateFrom,
    fps: fpsOf(rate),
    frameCount: f.frameCount,
    duration: Address.format(rate, f.frameCount),
    durationSeconds: secondsAt(rate, f.frameCount),
    size: f.size,
    seekable: true,
    live: false,
    vfr: f.clock !== undefined,
    tracks: (f.tracks ?? []).map(({ name, unit }) => ({ name, unit })),
    markers: f.markers ?? []
  }
}

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
