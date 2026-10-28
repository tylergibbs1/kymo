/**
 * What source string the model is handed. A synthetic spec names its own answer (`flicker?at=45`)
 * and opens with `truth` markers, so it is rendered once to a directory of PNGs under an
 * opaque name and the model gets that: pixels only, no parameters, no markers.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type KymoError, frameIndex } from "@kymo/core"
import { Sources, SyntheticAdapter } from "@kymo/sources"
import { Effect, Layer, Stream } from "effect"
import sharp from "sharp"
import type { Task } from "./Task.ts"

const SyntheticSources = Sources.layerFrom(SyntheticAdapter).pipe(Layer.provide(SyntheticAdapter.layer))

const rateParam = (task: Task) =>
  task.clock.rate.den === 1 ? String(task.clock.rate.num) : `${task.clock.rate.num}/${task.clock.rate.den}`

/** Render a synthetic spec to `<cacheDir>/<hash>/NNNNN.png`. Reuses a complete earlier rendering. */
export const renderFrames = (spec: string, cacheDir: string): Effect.Effect<string, KymoError> => {
  const dir = join(cacheDir, createHash("sha256").update(spec).digest("hex").slice(0, 16))
  if (existsSync(join(dir, ".complete"))) return Effect.succeed(dir)
  const partial = `${dir}.partial-${process.pid}`
  return Effect.gen(function* () {
    const sources = yield* Sources
    const source = yield* sources.open(spec, "render")
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })
    const indices = Array.from({ length: source.timeline.frameCount }, (_, i) => frameIndex(i))
    yield* Stream.runForEach(source.readFrames(indices), (frame) =>
      Effect.promise(() =>
        sharp(Buffer.from(frame.image.data), {
          raw: { width: frame.image.width, height: frame.image.height, channels: 3 }
        })
          .png()
          .toFile(join(partial, `${String(frame.index).padStart(5, "0")}.png`))
      )
    )
    writeFileSync(join(partial, ".complete"), "")
    rmSync(dir, { recursive: true, force: true })
    renameSync(partial, dir)
    return dir
  }).pipe(Effect.scoped, Effect.provide(SyntheticSources))
}

/** The source string the model gets for a task. Non-synthetic sources pass through unchanged. */
export const present = (task: Task, cacheDir: string): Effect.Effect<string, KymoError> =>
  !task.source.startsWith("synthetic:")
    ? Effect.succeed(task.source)
    : Effect.map(renderFrames(task.source, cacheDir), (dir) => `${dir}?fps=${rateParam(task)}`)
