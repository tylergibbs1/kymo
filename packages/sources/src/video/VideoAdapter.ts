import { type FrameIndex, SourceNotFound, secondsAt } from "@kymo/core"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { RegisteredAdapter } from "../Adapter.ts"
import { fitWithin } from "../Resize.ts"
import { makeTimeline, trackLookup } from "../Timeline.ts"
import { locateBinaries } from "./Binaries.ts"
import { readVideoFrames } from "./Decode.ts"
import { probe } from "./Probe.ts"

const EXTENSIONS = [".mp4", ".mov", ".webm", ".mkv", ".m4v"]

/** Video files via ffprobe (metadata) and ffmpeg (frames). Binaries are found when a file is opened. */
export class VideoAdapter extends Context.Service<VideoAdapter, RegisteredAdapter>()(
  "@kymo/sources/VideoAdapter"
) {
  static readonly layerNoDeps = Layer.effect(VideoAdapter)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      return VideoAdapter.of({
        kind: "video",
        accepts: `a video file (${EXTENSIONS.join(" ")})`,
        claims: (input) => EXTENSIONS.some((ext) => input.toLowerCase().endsWith(ext)),
        open: (input, handle) =>
          Effect.gen(function* () {
            const exists = yield* fs.exists(input).pipe(Effect.orElseSucceed(() => false))
            if (!exists) {
              return yield* new SourceNotFound({
                message: `No file at ${input}.`,
                hint: "Check the path; relative paths are resolved from the current directory."
              })
            }
            const bins = yield* locateBinaries(fs, path)
            const info = yield* probe(spawner, bins, input)
            const first = info.pts[0]!
            const timeline = makeTimeline({
              handle,
              kind: "video",
              input,
              rate: info.rate,
              frameCount: info.pts.length,
              size: info.size,
              ...(info.vfr ? { vfrDurationSeconds: info.durationSeconds } : {})
            })
            const timeAt = info.vfr
              ? (i: FrameIndex) => info.pts[i]! - first
              : (i: FrameIndex) => secondsAt(info.rate, i)
            const read = readVideoFrames(spawner, bins, input, info, timeAt)
            return {
              timeline,
              track: trackLookup(handle, []),
              readFrames: (indices, options) => read(indices, fitWithin(info.size, options))
            }
          })
      })
    })
  )

  static readonly layer = VideoAdapter.layerNoDeps.pipe(Layer.provide(NodeServices.layer))
}
