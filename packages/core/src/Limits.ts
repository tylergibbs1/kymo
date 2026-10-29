import { Effect } from "effect"
import { FrameCapExceeded } from "./Errors.ts"

/** Frame requests above this are refused unless the caller opts out (`--uncapped`). */
export const FRAME_CAP = 100

/** Frames measured without images (frames' numbersOnly): numbers are cheap, but not free to read. */
export const NUMBERS_CAP = 1000

/**
 * Refuse more than `cap` frames (default `FRAME_CAP`). `advice` is the caller's own way to ask for
 * fewer, naming only fields it has (e.g. a stepped range), so the hint never suggests an option the
 * call cannot take.
 */
export const enforceFrameCap = (
  requested: number,
  uncapped: boolean,
  advice: string,
  cap: number = FRAME_CAP
): Effect.Effect<void, FrameCapExceeded> =>
  requested <= cap || uncapped
    ? Effect.void
    : Effect.fail(
        new FrameCapExceeded({
          message: `${requested} frames requested; the limit is ${cap}.`,
          hint: `${advice} Pass uncapped to override.`
        })
      )

/** The smallest whole-frame step that brings `count` consecutive frames under the cap. */
export const capStep = (count: number): number => Math.max(2, Math.ceil(count / FRAME_CAP))
