import type { Adapter, FrameIndex, KymoError, RgbImage, Size, Source, Timeline, Track } from "@kymo/core"
import { Effect, Stream } from "effect"
import { fitWithin } from "./Resize.ts"
import { trackLookup } from "./Timeline.ts"

/** A core Adapter plus the one line the registry shows when nothing claims an input. */
export interface RegisteredAdapter extends Adapter {
  /** What inputs this adapter takes, e.g. `a video file (.mp4 .mov .webm .mkv)`. */
  readonly accepts: string
}

/**
 * A Source for backends that decode one frame at a time. `decode` receives the output size already
 * fitted to `maxEdge`; frames come back in the order requested.
 */
export const frameSource = (options: {
  readonly timeline: Timeline
  readonly tracks: ReadonlyArray<Track>
  readonly timeAt: (index: FrameIndex) => number
  readonly decode: (index: FrameIndex, target: Size) => Effect.Effect<RgbImage, KymoError>
  readonly concurrency?: number
}): Source => {
  const { timeline } = options
  const size = timeline.size ?? { width: 1, height: 1 }
  return {
    timeline,
    track: trackLookup(timeline.handle, options.tracks),
    readFrames: (indices, readOptions) => {
      const target = fitWithin(size, readOptions)
      return Stream.fromIterable(indices).pipe(
        Stream.mapEffect(
          (index) =>
            Effect.map(options.decode(index, target), (image) => ({
              index,
              t: options.timeAt(index),
              image
            })),
          { concurrency: options.concurrency ?? 1 }
        )
      )
    }
  }
}
