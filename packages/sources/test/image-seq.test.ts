import { assert, describe, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import sharp from "sharp"
import { afterAll, beforeAll } from "vitest"
import { Sources } from "../src/index.ts"
import { read } from "./helpers.ts"

let dir = ""
let frames = ""
let gif = ""
let reference = new Uint8Array()
const FRAME = 64 * 36 * 3

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kymo-seq-"))
  frames = join(dir, "frames")
  mkdirSync(frames)
  const ffmpeg = (...args: Array<string>) =>
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args])
  const src = ["-f", "lavfi", "-i", "testsrc2=size=64x36:rate=10:duration=1.2"]
  // Unpadded names: f2.png must sort before f10.png.
  ffmpeg(...src, "-start_number", "1", join(frames, "f%d.png"))
  ffmpeg(...src, "-f", "rawvideo", "-pix_fmt", "rgb24", join(dir, "all.rgb"))
  reference = new Uint8Array(readFileSync(join(dir, "all.rgb")))
  gif = join(dir, "anim.gif")
  ffmpeg(...src, gif)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const open = (input: string) =>
  Effect.gen(function* () {
    const sources = yield* Sources
    return yield* sources.open(input, "seq")
  }).pipe(Effect.scoped, Effect.provide(Sources.layer))

describe("image sequence sources", () => {
  it.effect("a directory of PNGs plays in natural order at the default 30 fps, recorded in input", () =>
    Effect.gen(function* () {
      const source = yield* open(frames)
      const t = source.timeline
      assert.deepStrictEqual(
        [t.kind, t.frameCount, t.rate, t.size, t.input],
        ["image-seq", 12, { num: 30, den: 1 }, { width: 64, height: 36 }, `${frames}?fps=30`]
      )
      const got = yield* read(source, [9, 1, 11])
      for (const f of got) {
        const want = reference.subarray(f.index * FRAME, (f.index + 1) * FRAME)
        assert.isTrue(Buffer.from(f.image.data).equals(want), `#${f.index}`)
      }
      const [small] = yield* read(source, [0], { maxEdge: 32 })
      assert.deepStrictEqual([small!.image.width, small!.image.height], [32, 18])
    })
  )

  it.effect("a directory's rate is marked assumed until ?fps= gives it; a GIF's comes from the file", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* open(frames)).timeline.rateFrom, "assumed")
      assert.strictEqual((yield* open(`${frames}?fps=60`)).timeline.rateFrom, "param")
      assert.strictEqual((yield* open(gif)).timeline.rateFrom, "source")
    })
  )

  it.effect("?fps= sets the rate", () =>
    Effect.gen(function* () {
      const source = yield* open(`${frames}?fps=24000/1001`)
      assert.deepStrictEqual(source.timeline.rate, { num: 24000, den: 1001 })
      const error = yield* Effect.flip(open(`${frames}?fsp=24`))
      assert.strictEqual(error._tag, "InvalidInput")
    })
  )

  it.effect("an animated GIF takes its rate from frame delays", () =>
    Effect.gen(function* () {
      const source = yield* open(gif)
      const t = source.timeline
      assert.deepStrictEqual(
        [t.frameCount, t.rate, t.size, t.vfr],
        [12, { num: 10, den: 1 }, { width: 64, height: 36 }, false]
      )
      const frames = yield* read(source, [11, 0])
      assert.deepStrictEqual(
        frames.map((f) => [f.index, f.t, f.image.width]),
        [
          [11, 1.1, 64],
          [0, 0, 64]
        ]
      )
    })
  )

  it.effect("uneven GIF delays make a variable-rate timeline", () =>
    Effect.gen(function* () {
      const uneven = join(dir, "uneven.gif")
      const delay = Array.from({ length: 12 }, (_, i) => (i < 6 ? 100 : 50))
      yield* Effect.promise(() => sharp(gif, { animated: true }).gif({ delay }).toFile(uneven))
      // The encoder may merge identical frames, so expect what the file actually holds.
      const meta = yield* Effect.promise(() => sharp(uneven, { animated: true }).metadata())
      const starts = meta.delay!.map((_, i) => meta.delay!.slice(0, i).reduce((a, b) => a + b, 0) / 1000)
      const source = yield* open(uneven)
      const t = source.timeline
      assert.deepStrictEqual([t.frameCount, t.vfr, t.durationSeconds], [meta.pages, true, 0.9])
      const all = Array.from({ length: t.frameCount }, (_, i) => i)
      assert.deepStrictEqual(
        (yield* read(source, all)).map((f) => f.t),
        starts
      )
    })
  )

  it.effect("a missing directory is SourceNotFound", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(open(join(dir, "missing")))
      assert.strictEqual(error._tag, "SourceNotFound")
    })
  )
})
