import { BackendFailure } from "@kymo/core"
import { Context, Effect, Layer } from "effect"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const failure = (dir: string) => (cause: unknown) =>
  new BackendFailure({
    message: `Could not create the output directory ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`,
    hint: "Pass a writable directory with --out, or check the temp directory has space."
  })

/**
 * Where images are written: `<root>/<handle>/<file>.png`. The root is a fresh `kymo-*` temp directory
 * per process, created on first use, unless a directory is given.
 */
export class OutputDir extends Context.Service<
  OutputDir,
  {
    /** The root directory, created if needed. */
    readonly root: Effect.Effect<string, BackendFailure>
    /** The directory for one source's images, created if needed. */
    dirFor(handle: string): Effect.Effect<string, BackendFailure>
  }
>()("kymo/OutputDir") {
  /** Images under `dir`, or under a fresh temp directory when `dir` is undefined. */
  static readonly layer = (dir?: string): Layer.Layer<OutputDir> =>
    Layer.effect(OutputDir)(
      Effect.gen(function* () {
        const make =
          dir === undefined
            ? Effect.tryPromise({
                try: () => mkdtemp(join(tmpdir(), "kymo-")),
                catch: failure(join(tmpdir(), "kymo-*"))
              })
            : Effect.tryPromise({
                try: () => mkdir(resolve(dir), { recursive: true }).then(() => resolve(dir)),
                catch: failure(dir)
              })
        const root = yield* Effect.cached(make)
        return OutputDir.of({
          root,
          dirFor: (handle) =>
            Effect.flatMap(root, (r) =>
              Effect.tryPromise({
                try: () => mkdir(join(r, handle), { recursive: true }).then(() => join(r, handle)),
                catch: failure(join(r, handle))
              })
            )
        })
      })
    )
}
