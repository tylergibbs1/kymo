/** Running operations the way every shell does, in a fresh workspace, plus media fixtures made with ffmpeg. */
import { type AnyOperation, type Operation, execute, kymoLayer } from "kymo"
import { Effect, Layer, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"

/** A fresh workspace root and image directory per test, removed afterwards. */
export const fresh = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "kymo-ops-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
    ),
    (dir) => kymoLayer({ root: dir, out: join(dir, "out") })
  )
)

type Codec = Schema.Codec<unknown, unknown, never, never>

/** Raw JSON in; the JSON out is decoded with the output Schema, so a test sees exactly what a shell prints. */
export const call = <I extends Codec, O extends Codec>(op: Operation<I, O>, input: unknown) =>
  Effect.flatMap(execute(op, input), (json) => Schema.decodeUnknownEffect(op.output)(json))

export const failure = (op: AnyOperation, input: unknown) => Effect.flip(execute(op, input))

/** A temp directory for media made once per test file. Call `remove` in afterAll. */
export const mediaDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kymo-media-"))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

export const ffmpeg = (...args: Array<string>) =>
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args])

/** `testsrc2` (a moving pattern with a clock) at a rate, so two rates show the same picture at the same time. */
export const testClip = (path: string, fps: number, seconds: number, size = "160x90") => {
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=${fps}:duration=${seconds}`,
    "-pix_fmt",
    "yuv420p",
    path
  )
  return path
}

/**
 * A variable-rate clip: 25 fps with frames 10–19 dropped, so frame #10 is shown at 0.8 s and the
 * average rate (about 20 fps) puts timecodes behind real time, like footage with dropped frames.
 */
export const droppedFramesClip = (path: string) => {
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=25:duration=2",
    "-vf",
    "select='not(between(n,10,19))'",
    "-fps_mode",
    "vfr",
    "-enc_time_base",
    "1/1000",
    "-pix_fmt",
    "yuv420p",
    path
  )
  return path
}

/** An animated GIF of flat grey frames with the given delays in ms. */
export const gifWithDelays = async (path: string, delays: ReadonlyArray<number>) => {
  const frames = delays.map((_, k) =>
    sharp({
      create: { width: 32, height: 24, channels: 3, background: { r: 20 * k, g: 20 * k, b: 20 * k } }
    })
      .png()
      .toBuffer()
  )
  await sharp(await Promise.all(frames), { join: { animated: true } })
    .gif({ delay: [...delays], loop: 0 })
    .toFile(path)
  return path
}
