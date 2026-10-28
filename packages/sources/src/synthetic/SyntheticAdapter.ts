import { InvalidInput } from "@kymo/core"
import { Context, Effect, Layer, Result } from "effect"
import { frameSource, type RegisteredAdapter } from "../Adapter.ts"
import { splitQuery } from "../Params.ts"
import { resizeTo } from "../Resize.ts"
import { makeMarker, makeTimeline } from "../Timeline.ts"
import type { Scene } from "./Scene.ts"
import { bounce } from "./scenes/bounce.ts"
import { cut } from "./scenes/cut.ts"
import { dropped } from "./scenes/dropped.ts"
import { ease } from "./scenes/ease.ts"
import { flicker } from "./scenes/flicker.ts"
import { safeArea } from "./scenes/safe-area.ts"

const PREFIX = "synthetic:"
const SCENES: ReadonlyArray<Scene> = [ease, bounce, flicker, safeArea, cut, dropped]
const COMMON = "Every scene also takes fps (default 30), frames (default 90) and size (default 640x360)."

/** Parse a `synthetic:<scene>?k=v&…` spec into a clip and a built scene. */
const parseSpec = (input: string) =>
  Result.flatMap(splitQuery(input.slice(PREFIX.length)), ({ path: name, params }) => {
    const scene = SCENES.find((s) => s.name === name)
    if (!scene) {
      return Result.fail(
        new InvalidInput({
          message: `Unknown synthetic scene "${name}". Scenes: ${SCENES.map((s) => s.name).join(", ")}.`,
          hint: `Write synthetic:<scene>?param=value, e.g. synthetic:bounce?fps=30&frames=90. ${COMMON}`
        })
      )
    }
    return Result.mapError(
      scene.build(params),
      (e) => new InvalidInput({ message: e.message, hint: `${e.hint} ${scene.summary} ${COMMON}` })
    )
  })

/**
 * Deterministic scenes rendered in-process, with exact ground truth: `box.*` tracks and `truth`
 * markers. For evals and tests.
 */
export class SyntheticAdapter extends Context.Service<SyntheticAdapter, RegisteredAdapter>()(
  "@kymo/sources/SyntheticAdapter"
) {
  static readonly layer = Layer.succeed(SyntheticAdapter)({
    kind: "synthetic",
    accepts: `a synthetic:<scene>?… spec (scenes: ${SCENES.map((s) => s.name).join(", ")})`,
    claims: (input) => input.startsWith(PREFIX),
    open: (input, handle) =>
      Effect.gen(function* () {
        const { clip, model } = yield* Effect.fromResult(parseSpec(input))
        const timeline = makeTimeline({
          handle,
          kind: "synthetic",
          input,
          rate: clip.rate,
          rateFrom: "source",
          frameCount: clip.frames,
          size: clip.size,
          tracks: model.tracks,
          markers: model.markers.map((m) => makeMarker(clip.rate, m.name, m.index, "truth"))
        })
        return frameSource({
          timeline,
          tracks: model.tracks,
          decode: (i, target) => Effect.sync(() => resizeTo(model.render(i), target))
        })
      })
  })
}
