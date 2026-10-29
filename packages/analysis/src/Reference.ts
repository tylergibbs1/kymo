/**
 * Visible change of each frame against one fixed reference frame, inside a box or over the whole
 * frame: "does N still differ from the last frame?" in one call. The same pixel rule as the change
 * from the previous frame (see Change.ts), with the noise floor read from consecutive frames, which
 * show the clip's encoder noise whatever the reference is.
 */
import { type FrameIndex, InvalidInput, type KymoError, type Source, frameIndex } from "@kymo/core"
import { Effect, Stream } from "effect"
import { type Cut, type FrameChange, cutBox, frameChange, ruleOf, workEdge } from "./Change.ts"
import { toGray } from "./Pixels.ts"
import type { Box } from "./Tracker.ts"

/**
 * Each of `indices` against frame `against`, inside `box` (source pixels). Reads every frame, the
 * frame before each (for the noise floor) and the reference once.
 */
export const referenceChanges = (
  source: Source,
  indices: ReadonlyArray<FrameIndex>,
  against: FrameIndex,
  box: Box
): Effect.Effect<{ readonly floor: number; readonly frames: ReadonlyArray<FrameChange> }, KymoError> =>
  Effect.gen(function* () {
    const size = source.timeline.size
    if (size === null)
      return yield* new InvalidInput({
        message: `${source.timeline.handle} has no pixels to diff.`,
        hint: "Diff a video, image sequence or synthetic scene."
      })
    const wanted = [...new Set([against, ...indices.flatMap((i) => [i - 1, i])])]
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)
      .map(frameIndex)
    const cuts = new Map<number, Cut>()
    let scale = 1
    yield* Stream.runForEach(source.readFrames(wanted, { maxEdge: workEdge(size, box) }), (frame) =>
      Effect.sync(() => {
        const c = cutBox(toGray(frame.image), size, box)
        scale = c.scale
        cuts.set(frame.index, c)
      })
    )
    const consecutive = indices.flatMap((i) => {
      const [a, b] = [cuts.get(i - 1), cuts.get(i)]
      return a === undefined || b === undefined ? [] : [[a, b] as const]
    })
    const rule = ruleOf(consecutive, scale)
    const ref = cuts.get(against)!
    const frames = indices.map((index) => frameChange(index, ref, cuts.get(index)!, rule))
    return { floor: rule.floor, frames }
  })
