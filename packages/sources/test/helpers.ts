import type { DecodedFrame, FrameIndex, KymoError, ReadOptions, Source } from "@kymo/core"
import { frameIndex } from "@kymo/core"
import { Effect, Stream } from "effect"

/** Read frames by plain index numbers and collect them. */
export const read = (
  source: Source,
  indices: ReadonlyArray<number>,
  options?: ReadOptions
): Effect.Effect<Array<DecodedFrame>, KymoError> =>
  Stream.runCollect(source.readFrames(indices.map(frameIndex) as ReadonlyArray<FrameIndex>, options))

/** Intensity-weighted centroid of pixels brighter than the background in one channel. */
export const centroid = (frame: DecodedFrame, channel: 0 | 1 | 2, threshold: number) => {
  const { width, height, data } = frame.image
  let sx = 0
  let sy = 0
  let total = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[(y * width + x) * 3 + channel]!
      if (v > threshold) {
        const w = v - threshold
        sx += (x + 0.5) * w
        sy += (y + 0.5) * w
        total += w
      }
    }
  }
  return { x: sx / total, y: sy / total }
}
