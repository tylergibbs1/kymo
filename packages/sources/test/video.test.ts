import { assert, describe, it } from "@effect/vitest"
import { Address, resolveContext } from "@kymo/core"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect, Stream } from "effect"
import { frameIndex } from "@kymo/core"
import { afterAll, beforeAll } from "vitest"
import { Sources } from "../src/index.ts"
import { read } from "./helpers.ts"

let dir = ""
let clip = ""
/** Every frame of the fixture, decoded straight through by ffmpeg: the reference for exact reads. */
let reference = new Uint8Array()
let vfrClip = ""
let vfrReference = new Uint8Array()
const FRAME = 160 * 90 * 3

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kymo-video-"))
  clip = join(dir, "clip.mp4")
  const ffmpeg = (...args: Array<string>) =>
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args])
  // Short GOP and B-frames, so reads have to seek and reorder.
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:duration=2",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "12",
    clip
  )
  ffmpeg("-i", clip, "-f", "rawvideo", "-pix_fmt", "rgb24", join(dir, "all.rgb"))
  reference = new Uint8Array(readFileSync(join(dir, "all.rgb")))
  // 30 fps for the first second, then 10 fps: frame 30 is at 1.0 s, frame 31 at 1.1 s.
  vfrClip = join(dir, "vfr.mp4")
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30:duration=2",
    "-vf",
    "setpts='if(lt(N,30),N/30,1+(N-30)/10)/TB'",
    "-fps_mode",
    "vfr",
    "-enc_time_base",
    "1/1000",
    "-pix_fmt",
    "yuv420p",
    vfrClip
  )
  ffmpeg(
    "-i",
    vfrClip,
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    join(dir, "vfr.rgb")
  )
  vfrReference = new Uint8Array(readFileSync(join(dir, "vfr.rgb")))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const open = (input: string) =>
  Effect.gen(function* () {
    const sources = yield* Sources
    return yield* sources.open(input, "clip1")
  })

const referenceFrame = (i: number) => reference.subarray(i * FRAME, (i + 1) * FRAME)

describe("video sources", () => {
  it.effect("probes rate, frame count, size and constant frame rate", () =>
    Effect.gen(function* () {
      const { timeline } = yield* open(clip)
      assert.deepStrictEqual(
        [timeline.kind, timeline.rate, timeline.frameCount, timeline.size, timeline.vfr, timeline.duration],
        ["video", { num: 30, den: 1 }, 60, { width: 160, height: 90 }, false, "02s"]
      )
      assert.strictEqual(timeline.durationSeconds, 2)
      assert.deepStrictEqual(timeline.tracks, [])
    }).pipe(Effect.scoped, Effect.provide(Sources.layer))
  )

  it.effect("reads addressed frames exactly, in the requested order", () =>
    Effect.gen(function* () {
      const source = yield* open(clip)
      const ctx = resolveContext(source.timeline)
      const indices = [
        ...(yield* Address.resolveText(ctx, "#0")),
        ...(yield* Address.resolveText(ctx, "#30")),
        ...(yield* Address.resolveText(ctx, "-1f"))
      ]
      assert.deepStrictEqual(indices, [0, 30, 59])

      const frames = yield* read(source, [0, 30, 59])
      assert.deepStrictEqual(
        frames.map((f) => [f.index, f.t, f.image.width, f.image.height]),
        [
          [0, 0, 160, 90],
          [30, 1, 160, 90],
          [59, 59 / 30, 160, 90]
        ]
      )
      for (const f of frames)
        assert.isTrue(Buffer.from(f.image.data).equals(referenceFrame(f.index)), `#${f.index}`)

      const shuffled = yield* read(source, [45, 3, 3, 44, 46, 10])
      assert.deepStrictEqual(
        shuffled.map((f) => f.index),
        [45, 3, 3, 44, 46, 10]
      )
      for (const f of shuffled)
        assert.isTrue(Buffer.from(f.image.data).equals(referenceFrame(f.index)), `#${f.index}`)
    }).pipe(Effect.scoped, Effect.provide(Sources.layer))
  )

  it.effect("stopping early ends the ffmpeg process instead of hanging on a full pipe", () =>
    Effect.gen(function* () {
      const source = yield* open(clip)
      const all = Array.from({ length: 60 }, (_, i) => frameIndex(i))
      const first = yield* Stream.runCollect(Stream.take(source.readFrames(all), 1)).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die("readFrames did not stop") })
      )
      assert.deepStrictEqual(
        first.map((f) => f.index),
        [0]
      )
    }).pipe(Effect.scoped, Effect.provide(Sources.layer))
  )

  it.effect("downscales so the long edge fits maxEdge", () =>
    Effect.gen(function* () {
      const source = yield* open(clip)
      const [frame] = yield* read(source, [12], { maxEdge: 80 })
      assert.deepStrictEqual([frame!.index, frame!.image.width, frame!.image.height], [12, 80, 45])
      const [full] = yield* read(source, [12], { maxEdge: 4000 })
      assert.deepStrictEqual([full!.image.width, full!.image.height], [160, 90])
    }).pipe(Effect.scoped, Effect.provide(Sources.layer))
  )

  it.effect("variable frame rate: flagged, with frame times from presentation timestamps", () =>
    Effect.gen(function* () {
      const source = yield* open(vfrClip)
      const { timeline } = source
      assert.deepStrictEqual([timeline.vfr, timeline.frameCount], [true, 60])
      assert.approximately(timeline.durationSeconds, 4, 1e-6)
      const frames = yield* read(source, [29, 31, 59])
      assert.deepStrictEqual(
        frames.map((f) => Math.round(f.t * 1000)),
        [967, 1100, 3900]
      )
      for (const f of frames) {
        const want = vfrReference.subarray(f.index * FRAME, (f.index + 1) * FRAME)
        assert.isTrue(Buffer.from(f.image.data).equals(want), `#${f.index}`)
      }
    }).pipe(Effect.scoped, Effect.provide(Sources.layer))
  )

  it.effect("a bogus KYMO_FFMPEG is AdapterUnavailable", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(open(clip))
      assert.strictEqual(error._tag, "AdapterUnavailable")
      assert.strictEqual(error.message, "ffmpeg not found. Install it, or set KYMO_FFMPEG.")
      assert.include(error.hint, "/nonexistent/ffmpeg")
    }).pipe(
      Effect.scoped,
      Effect.provide(Sources.layer),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({ ...process.env, KYMO_FFMPEG: "/nonexistent/ffmpeg" })
        )
      )
    )
  )

  it.effect("a missing file is SourceNotFound", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(open(join(dir, "nope.mp4")))
      assert.strictEqual(error._tag, "SourceNotFound")
      assert.include(error.message, "nope.mp4")
    }).pipe(Effect.scoped, Effect.provide(Sources.layer))
  )

  it.effect("a file that isn't video is InvalidInput", () =>
    Effect.gen(function* () {
      const fake = join(dir, "fake.mov")
      execFileSync("sh", ["-c", `echo hello > '${fake}'`])
      const error = yield* Effect.flip(open(fake))
      assert.strictEqual(error._tag, "InvalidInput")
    }).pipe(Effect.scoped, Effect.provide(Sources.layer))
  )
})
