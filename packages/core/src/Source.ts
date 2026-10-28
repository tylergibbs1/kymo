import type { Effect, Scope, Stream } from "effect"
import type { KymoError } from "./Errors.ts"
import type { RgbImage } from "./Image.ts"
import type { FrameIndex } from "./Rate.ts"
import type { Timeline, Track } from "./Timeline.ts"

export interface DecodedFrame {
  readonly index: FrameIndex
  /** Presentation time in seconds. */
  readonly t: number
  readonly image: RgbImage
}

export interface ReadOptions {
  /** Downscale so the long edge is at most this many pixels. Analysis reads small; views read full size. */
  readonly maxEdge?: number
}

/**
 * An opened source. Views and analysis only ever see this shape, never what is behind it.
 * Frames come back in the order requested; indices must already be resolved and in range.
 */
export interface Source {
  readonly timeline: Timeline
  readonly readFrames: (
    indices: ReadonlyArray<FrameIndex>,
    options?: ReadOptions
  ) => Stream.Stream<DecodedFrame, KymoError>
  /** Samples for one of `timeline.tracks`. Fails with InvalidInput for an unknown name. */
  readonly track: (name: string) => Effect.Effect<Track, KymoError>
}

/** One kind of input. Each adapter is provided as a Layer and registered with the source registry. */
export interface Adapter {
  readonly kind: Timeline["kind"]
  /** True if this adapter claims the input (by scheme, extension or sniffing). Must not do I/O. */
  readonly claims: (input: string) => boolean
  /** Open the input. Processes, temp files and handles are tied to the Scope. */
  readonly open: (input: string, handle: string) => Effect.Effect<Source, KymoError, Scope.Scope>
}
