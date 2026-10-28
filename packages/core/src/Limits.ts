import { Effect } from "effect"
import { FrameCapExceeded } from "./Errors.ts"

/** Frame requests above this are refused unless the caller opts out (`--uncapped`). */
export const FRAME_CAP = 100

export const enforceFrameCap = (
  requested: number,
  uncapped: boolean
): Effect.Effect<void, FrameCapExceeded> =>
  requested <= FRAME_CAP || uncapped
    ? Effect.void
    : Effect.fail(
        new FrameCapExceeded({
          message: `${requested} frames requested; the limit is ${FRAME_CAP}.`,
          hint: "Use sample=motion, a step like 2s..4s:5f, or a shorter range. Pass uncapped to override."
        })
      )
