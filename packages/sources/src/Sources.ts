import { type KymoError, type Source, SourceNotFound } from "@kymo/core"
import { Context, Effect, Layer, type Scope } from "effect"
import type { RegisteredAdapter } from "./Adapter.ts"
import { ImageSeqAdapter } from "./image-seq/ImageSeqAdapter.ts"
import { SyntheticAdapter } from "./synthetic/SyntheticAdapter.ts"
import { VideoAdapter } from "./video/VideoAdapter.ts"

/** Any adapter service key: `VideoAdapter`, `SyntheticAdapter`, `ImageSeqAdapter`, or your own. */
export type AdapterKey<I = unknown> = Context.Key<I, RegisteredAdapter>

/** Opens any supported input by asking each registered adapter, in order, whether it claims it. */
export class Sources extends Context.Service<
  Sources,
  {
    /** Open `input` under `handle`. Processes and file handles live as long as the Scope. */
    open(input: string, handle: string): Effect.Effect<Source, KymoError, Scope.Scope>
    /** One line per registered adapter describing the inputs it takes. */
    readonly accepts: ReadonlyArray<string>
  }
>()("@kymo/sources/Sources") {
  /**
   * A registry over the given adapters, tried in order. Each adapter's layer must be provided;
   * forgetting one is a type error.
   */
  static readonly layerFrom = <const Keys extends ReadonlyArray<AdapterKey>>(
    ...keys: Keys
  ): Layer.Layer<Sources, never, Keys[number]["Identifier"]> =>
    Layer.effect(Sources)(
      Effect.gen(function* () {
        const adapters: Array<RegisteredAdapter> = []
        for (const key of keys) adapters.push(yield* key)
        const accepts = adapters.map((a) => a.accepts)
        return Sources.of({
          accepts,
          open: (input, handle) => {
            const adapter = adapters.find((a) => a.claims(input))
            if (adapter) return adapter.open(input, handle)
            return Effect.fail(
              new SourceNotFound({
                message: `Nothing can open "${input}".`,
                hint: `Supported inputs: ${accepts.join("; ")}.`
              })
            )
          }
        })
      })
    )

  /** Every built-in adapter: synthetic specs, video files, image sequences. */
  static readonly layer: Layer.Layer<Sources> = Sources.layerFrom(
    SyntheticAdapter,
    VideoAdapter,
    ImageSeqAdapter
  ).pipe(Layer.provide(Layer.mergeAll(SyntheticAdapter.layer, VideoAdapter.layer, ImageSeqAdapter.layer)))
}
