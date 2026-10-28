import {
  BackendFailure,
  type DecodedFrame,
  type FrameIndex,
  type KymoError,
  RgbImage,
  type Rate,
  type Size,
  secondsAt
} from "@kymo/core"
import { Effect, Fiber, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Binaries } from "./Binaries.ts"
import type { VideoInfo } from "./Probe.ts"
import { command, spawnFailure, stderrTail } from "./Run.ts"

/** One ffmpeg process: ascending distinct frames, each emitted `repeat` times. */
interface Batch {
  readonly frames: Array<{ readonly index: FrameIndex; repeat: number }>
}

/** Frames per select expression; keeps the filter argument short. */
const MAX_BATCH = 64

/**
 * Split a request into batches that preserve its order. A batch ends where the request goes
 * backwards, where the next frame is far enough ahead that seeking beats decoding through, or
 * when it is full.
 */
const plan = (indices: ReadonlyArray<FrameIndex>, seekGap: number): Array<Batch> => {
  const batches: Array<Batch> = []
  let current: Batch | undefined
  for (const index of indices) {
    const last = current?.frames[current.frames.length - 1]
    if (current && last && index === last.index) {
      last.repeat++
      continue
    }
    if (
      !current ||
      !last ||
      index < last.index ||
      index - last.index > seekGap ||
      current.frames.length >= MAX_BATCH
    ) {
      current = { frames: [] }
      batches.push(current)
    }
    current.frames.push({ index, repeat: 1 })
  }
  return batches
}

/** Re-cut a byte stream into fixed-size frames. */
const toFrames = (frameBytes: number) =>
  Stream.mapAccum(
    () => ({ buf: new Uint8Array(frameBytes), filled: 0 }),
    (state, chunk: Uint8Array) => {
      const out: Array<Uint8Array> = []
      let { buf, filled } = state
      let offset = 0
      while (offset < chunk.length) {
        const n = Math.min(frameBytes - filled, chunk.length - offset)
        buf.set(chunk.subarray(offset, offset + n), filled)
        filled += n
        offset += n
        if (filled === frameBytes) {
          out.push(buf)
          buf = new Uint8Array(frameBytes)
          filled = 0
        }
      }
      return [{ buf, filled }, out] as const
    }
  )

const decodeFailure = (path: string, detail: string) =>
  new BackendFailure({
    message: `ffmpeg could not decode ${path}: ${detail}`,
    hint: "The file may be truncated or use an unsupported codec. Try re-encoding it with ffmpeg."
  })

const ffmpegArgs = (path: string, info: VideoInfo, batch: Batch, target: Size): Array<string> => {
  const times = batch.frames.map((f) => info.pts[f.index]!)
  const seek = Math.max(0, times[0]! - info.start - 2 * info.halfGap - 1)
  const select = times.map((t) => `lt(abs(t-${t.toFixed(6)})\\,${info.halfGap.toFixed(6)})`).join("+")
  const scale =
    target.width === info.size.width && target.height === info.size.height
      ? ""
      : `,scale=${target.width}:${target.height}:flags=area`
  return [
    "-nostdin",
    "-v",
    "error",
    "-copyts",
    "-ss",
    seek.toFixed(6),
    "-i",
    path,
    "-map",
    "0:v:0",
    "-vf",
    `select='${select}'${scale}`,
    "-fps_mode",
    "passthrough",
    "-frames:v",
    String(batch.frames.length),
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1"
  ]
}

/** One ffmpeg process for one batch. The process lives exactly as long as the stream is consumed. */
const decodeBatch = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  bins: Binaries,
  path: string,
  info: VideoInfo,
  batch: Batch,
  target: Size,
  clock: Rate
): Stream.Stream<DecodedFrame, KymoError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(command(bins.ffmpeg, ffmpegArgs(path, info, batch, target)))
        .pipe(Effect.mapError(spawnFailure(bins.ffmpeg)))
      const stderr = yield* Stream.mkString(Stream.decodeText(handle.stderr)).pipe(Effect.forkScoped)
      let produced = 0
      const finish = Effect.gen(function* () {
        const exitCode = yield* handle.exitCode
        const errors = yield* Fiber.join(stderr)
        if (exitCode !== 0) return yield* decodeFailure(path, stderrTail(errors) || `exit code ${exitCode}`)
        if (produced !== batch.frames.length) {
          return yield* decodeFailure(
            path,
            `got ${produced} of ${batch.frames.length} frames; the file may be shorter than its index says`
          )
        }
      }).pipe(Effect.mapError((e) => (e._tag === "PlatformError" ? spawnFailure(bins.ffmpeg)(e) : e)))

      return handle.stdout.pipe(
        Stream.mapError(spawnFailure(bins.ffmpeg)),
        toFrames(target.width * target.height * 3),
        Stream.flatMap((bytes) => {
          const { index, repeat } = batch.frames[produced++]!
          const frame = {
            index,
            t: secondsAt(clock, index),
            image: RgbImage.make(target.width, target.height, bytes)
          }
          return Stream.fromIterable(Array.from({ length: repeat }, () => frame))
        }),
        Stream.concat(Stream.drain(Stream.fromEffect(finish)))
      )
    })
  )

/** Read frames in the requested order, one ffmpeg process per batch, run one after another. */
export const readVideoFrames =
  (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    bins: Binaries,
    path: string,
    info: VideoInfo,
    clock: Rate
  ) =>
  (indices: ReadonlyArray<FrameIndex>, target: Size): Stream.Stream<DecodedFrame, KymoError> => {
    const fps = info.rate.num / info.rate.den
    return Stream.fromIterable(plan(indices, Math.max(30, Math.round(fps * 2)))).pipe(
      Stream.flatMap((batch) => decodeBatch(spawner, bins, path, info, batch, target, clock))
    )
  }
