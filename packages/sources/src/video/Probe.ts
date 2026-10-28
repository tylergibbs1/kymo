import { InvalidInput, type Rate, type Size } from "@kymo/core"
import { Effect, Result, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { parseRational } from "../Params.ts"
import type { Binaries } from "./Binaries.ts"
import { run, stderrTail } from "./Run.ts"

/** What the decoder needs to know about a video, read once at open. */
export interface VideoInfo {
  readonly rate: Rate
  readonly size: Size
  /** Presentation time of every frame in seconds, ascending, in the file's own timebase. */
  readonly pts: ReadonlyArray<number>
  /** The container's start time; ffmpeg's `-ss` counts from here. */
  readonly start: number
  /** Frame durations vary by more than a quarter of the typical one. */
  readonly vfr: boolean
  /** First frame to the end of the last; the last frame lasts as long as the gap before it. */
  readonly durationSeconds: number
  /** Half the smallest gap between frames: the tolerance for selecting a frame by its pts. */
  readonly halfGap: number
}

const Seconds = Schema.FiniteFromString
const ProbeJson = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      width: Schema.Int,
      height: Schema.Int,
      r_frame_rate: Schema.String,
      avg_frame_rate: Schema.String,
      side_data_list: Schema.optionalKey(
        Schema.Array(Schema.Struct({ rotation: Schema.optionalKey(Schema.Number) }))
      )
    })
  ),
  packets: Schema.optionalKey(Schema.Array(Schema.Struct({ pts_time: Schema.optionalKey(Seconds) }))),
  format: Schema.optionalKey(Schema.Struct({ start_time: Schema.optionalKey(Seconds) }))
})
const decodeProbe = Schema.decodeUnknownResult(Schema.fromJsonString(ProbeJson))

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

const notVideo = (path: string, why: string) =>
  new InvalidInput({
    message: `${path} could not be read as video: ${why}`,
    hint: "Check the file is a complete video (mp4, mov, webm, mkv). Re-encode it with ffmpeg if it plays elsewhere."
  })

/** Probe a video's rate, size and per-frame timestamps with ffprobe. */
export const probe = Effect.fnUntraced(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  bins: Binaries,
  path: string
) {
  const out = yield* run(spawner, bins.ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate,avg_frame_rate:stream_side_data=rotation:format=start_time:packet=pts_time",
    "-of",
    "json",
    path
  ])
  if (out.exitCode !== 0) return yield* notVideo(path, stderrTail(out.stderr))
  const parsed = decodeProbe(out.stdout)
  if (Result.isFailure(parsed))
    return yield* notVideo(path, `unexpected ffprobe output (${parsed.failure.message})`)
  const { streams, packets, format } = parsed.success
  const stream = streams[0]
  if (!stream) return yield* notVideo(path, "it has no video stream")

  const pts = (packets ?? [])
    .flatMap((p) => (p.pts_time === undefined ? [] : [p.pts_time]))
    .sort((a, b) => a - b)
  if (pts.length === 0) return yield* notVideo(path, "it has no video frames")

  const gaps = pts.slice(1).map((t, i) => t - pts[i]!)
  const typical = gaps.length > 0 ? median(gaps) : 0
  const vfr = typical > 0 && gaps.some((g) => Math.abs(g - typical) > typical / 4)
  const declared = parseRational(stream.r_frame_rate) ?? parseRational(stream.avg_frame_rate)
  const average = parseRational(stream.avg_frame_rate) ?? declared
  const rate = vfr ? average : declared
  if (!rate) return yield* notVideo(path, "ffprobe reports no frame rate")

  const minGap = gaps.reduce((m, g) => (g > 0 && g < m ? g : m), rate.den / rate.num)
  const rotation = Math.abs(stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0) % 180
  const size =
    rotation === 90
      ? { width: stream.height, height: stream.width }
      : { width: stream.width, height: stream.height }

  return {
    rate,
    size,
    pts,
    start: format?.start_time ?? pts[0]!,
    vfr,
    durationSeconds: pts[pts.length - 1]! - pts[0]! + (gaps[gaps.length - 1] ?? rate.den / rate.num),
    halfGap: minGap / 2
  } satisfies VideoInfo
})
