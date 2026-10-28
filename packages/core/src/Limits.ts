import { Effect } from "effect"
import { FrameCapExceeded } from "./Errors.ts"

/** Frame requests above this are refused unless the caller opts out (`--uncapped`). */
export const FRAME_CAP = 100

/**
 * Refuse more than `FRAME_CAP` frames. `advice` is the caller's own way to ask for fewer, naming only
 * fields it has (e.g. a stepped range), so the hint never suggests an option the call cannot take.
 */
export const enforceFrameCap = (
  requested: number,
  uncapped: boolean,
  advice: string
): Effect.Effect<void, FrameCapExceeded> =>
  requested <= FRAME_CAP || uncapped
    ? Effect.void
    : Effect.fail(
        new FrameCapExceeded({
          message: `${requested} frames requested; the limit is ${FRAME_CAP}.`,
          hint: `${advice} Pass uncapped to override.`
        })
      )

/** The smallest whole-frame step that brings `count` consecutive frames under the cap. */
export const capStep = (count: number): number => Math.max(2, Math.ceil(count / FRAME_CAP))
