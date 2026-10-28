import { describe, expect, it } from "@effect/vitest"
import { Address, frameIndex } from "@kymo/core"
import { highRes, planGrid, standard } from "@kymo/layout"
import {
  FollowBox,
  ViewImage,
  ViewResult,
  compare,
  diff,
  filmstrip,
  follow,
  onion,
  plot,
  sheet
} from "@kymo/views"
import { Effect, Result, Schema } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import sharp from "sharp"
import { BACKGROUND, SQUARE, fakeSource } from "./FakeSource.ts"

const tempDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "kymo-views-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
)

const pixels = (path: string) =>
  Effect.promise(async () => {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height, channels: info.channels }
  })

const indices = (...ns: Array<number>) => ns.map(frameIndex)

describe("sheet", () => {
  it.effect("writes one PNG per page sized and named as planned, identical on rerun", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const source = fakeSource()
      const frames = indices(0, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250)
      const result = yield* sheet({ source, frames, outDir: dir, target: standard })
      expect(result.next).toBeNull()
      expect(result.images).toHaveLength(1)
      const image = result.images[0]!
      expect(basename(image.path)).toBe("0f-08s10f.png")
      expect(image.span).toBe(Address.spanName(source.timeline.rate, 0, 250))
      expect(image.frames.map((f) => f.address)).toContain("08s10f")
      const plan = planGrid({
        count: 11,
        frame: { width: 320, height: 180 },
        target: standard,
        labelChars: 11
      })
      if (Result.isFailure(plan)) throw new Error("plan")
      expect([image.width, image.height]).toEqual([plan.success.width, plan.success.height])
      const meta = yield* Effect.promise(() => sharp(image.path).metadata())
      expect([meta.width, meta.height]).toEqual([image.width, image.height])
      const first = yield* Effect.promise(() => readFile(image.path))
      yield* sheet({ source, frames, outDir: dir, target: standard })
      const second = yield* Effect.promise(() => readFile(image.path))
      expect(Buffer.compare(first, second)).toBe(0)
      // Frames are requested at the planned size, not decoded full size.
      expect(source.reads[0]).toBe(Math.max(plan.success.frame.width, plan.success.frame.height))
    }).pipe(Effect.scoped)
  )

  it.effect("paginates long lists and continues from the cursor", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const source = fakeSource({ width: 1920, height: 1080 })
      const frames = Array.from({ length: 30 }, (_, i) => frameIndex(i * 3))
      const first = yield* sheet({ source, frames, outDir: dir, target: highRes, maxSheets: 2 })
      expect(first.images).toHaveLength(2)
      expect(first.next).not.toBeNull()
      const rest = yield* sheet({
        source,
        frames,
        outDir: dir,
        target: highRes,
        cursor: first.next ?? undefined
      })
      expect(rest.next).toBeNull()
      const all = [...first.images, ...rest.images].flatMap((i) => i.frames.map((f) => f.index))
      expect(all).toEqual(frames)
      for (const i of [...first.images, ...rest.images]) {
        expect(Math.max(i.width, i.height)).toBeLessThanOrEqual(2576)
        expect(i.tokens).toBeLessThanOrEqual(4784)
      }
    }).pipe(Effect.scoped)
  )

  it.effect("refuses frames past the end", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const e = yield* Effect.flip(
        sheet({ source: fakeSource(), frames: indices(5000), outDir: dir, target: standard })
      )
      expect(e._tag).toBe("AddressOutOfRange")
    }).pipe(Effect.scoped)
  )
})

/** Largest channel value in a region of a decoded PNG. */
const brightest = (
  img: { data: Buffer; width: number; channels: number },
  x: number,
  y: number,
  w: number,
  h: number
) => {
  let max = 0
  for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++)
      for (let c = 0; c < 3; c++) max = Math.max(max, img.data[(row * img.width + col) * img.channels + c]!)
  return max
}

const sameBytesOnRerun = <A extends { readonly path: string }, E>(run: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const first = yield* run
    const bytes = yield* Effect.promise(() => readFile(first.path))
    const second = yield* run
    expect(second.path).toBe(first.path)
    expect(Buffer.compare(bytes, yield* Effect.promise(() => readFile(second.path)))).toBe(0)
    return first
  })

describe("diff", () => {
  it.effect("is black where nothing moved and bright where the square moved", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const still = fakeSource({ squareX: () => 100 })
      const [stillImage] = (yield* diff({
        source: still,
        frames: indices(10),
        outDir: dir,
        target: standard
      })).images
      expect(basename(stillImage!.path)).toBe("10f.diff.png")
      const quiet = yield* pixels(stillImage!.path)
      // The frame area (above the label bar) is the colormap's black.
      expect(brightest(quiet, 0, 0, 320, 180)).toBeLessThan(8)
      const moving = fakeSource()
      const [movingImage] = (yield* diff({
        source: moving,
        frames: indices(10),
        outDir: dir,
        target: standard
      })).images
      expect(brightest(yield* pixels(movingImage!.path), 0, 0, 320, 180)).toBeGreaterThan(100)
    }).pipe(Effect.scoped)
  )

  it.effect("refuses the first frame, which has nothing before it", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const e = yield* Effect.flip(
        diff({ source: fakeSource(), frames: indices(0, 5), outDir: dir, target: standard })
      )
      expect(e._tag).toBe("InvalidInput")
    }).pipe(Effect.scoped)
  )
})

describe("onion", () => {
  it.effect("shows the square at several past positions in one image", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const source = fakeSource({ squareX: (i) => i * 5 })
      const frames = indices(0, 10, 20, 30, 40)
      const image = yield* sameBytesOnRerun(onion({ source, frames, outDir: dir, target: standard }))
      expect(basename(image.path)).toBe("0f-01s10f.onion.png")
      expect(image.frames).toHaveLength(5)
      const img = yield* pixels(image.path)
      const y = Math.floor((180 - SQUARE) / 2) + SQUARE / 2
      const bg = Math.max(...BACKGROUND)
      // Centre of the square in each frame: every one stands out from the dimmed background.
      for (const i of frames) expect(brightest(img, i * 5 + SQUARE / 2, y, 1, 1)).toBeGreaterThan(bg + 30)
      // The newest is at full strength; the oldest is fainter.
      expect(brightest(img, 40 * 5 + SQUARE / 2, y, 1, 1)).toBeGreaterThan(
        brightest(img, SQUARE / 2, y, 1, 1)
      )
    }).pipe(Effect.scoped)
  )
})

describe("filmstrip", () => {
  it.effect("samples evenly, end to end, with one ruler-labelled sheet", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const source = fakeSource()
      const result = yield* filmstrip({ source, count: 6, outDir: dir, target: highRes })
      const image = result.images[0]!
      expect(image.frames.map((f) => f.index)).toEqual([0, 60, 120, 179, 239, 299])
      expect(basename(image.path)).toBe("0f-09s29f.filmstrip.png")
      const meta = yield* Effect.promise(() => sharp(image.path).metadata())
      expect([meta.width, meta.height]).toEqual([image.width, image.height])
    }).pipe(Effect.scoped)
  )
})

describe("compare", () => {
  it.effect("puts the same frames of both sources side by side, and diffs identical sources to black", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const a = fakeSource()
      const b = fakeSource({ handle: "clip2" })
      const frames = indices(0, 50, 250)
      const side = yield* compare({ a, b, frames, outDir: dir, target: standard })
      expect(basename(side.images[0]!.path)).toBe("0f-08s10f.compare.clip1.clip2.png")
      const sideImg = yield* pixels(side.images[0]!.path)
      expect(sideImg.width).toBeGreaterThanOrEqual(2 * 320)
      const d = yield* compare({ a, b, frames, outDir: dir, target: standard, mode: "diff" })
      expect(basename(d.images[0]!.path)).toBe("0f-08s10f.compare-diff.clip1.clip2.png")
      const plan = planGrid({
        count: 3,
        frame: { width: 320, height: 180 },
        target: standard,
        labelChars: "clip1-clip2@08s10f #250".length
      })
      if (Result.isFailure(plan)) throw new Error("plan")
      const dImg = yield* pixels(d.images[0]!.path)
      for (const { frame } of plan.success.cells)
        expect(brightest(dImg, frame.x, frame.y, frame.width, frame.height)).toBeLessThan(8)
    }).pipe(Effect.scoped)
  )
})

describe("follow", () => {
  it.effect("crops a tracked box at source resolution at most", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const source = fakeSource()
      const result = yield* follow({
        source,
        frames: indices(0, 30, 60),
        box: { _tag: "Tracked", x: "x", y: "y", width: 80, height: 60 },
        outDir: dir,
        target: highRes
      })
      const image = result.images[0]!
      expect(basename(image.path)).toBe("0f-02s.follow.x-y-80x60.png")
      const img = yield* pixels(image.path)
      // Never upscaled: three 80x60 crops, widened only to fit their labels.
      expect(img.height).toBe(60 + 40)
      // The box follows the square, so each crop's centre is the square.
      const plan = planGrid({
        count: 3,
        frame: { width: 80, height: 60 },
        target: highRes,
        labelChars: "01s #30".length
      })
      if (Result.isFailure(plan)) throw new Error("plan")
      for (const cell of plan.success.cells)
        expect(brightest(img, cell.frame.x + 40, cell.frame.y + 30, 1, 1)).toBeGreaterThan(200)
    }).pipe(Effect.scoped)
  )

  it.effect("refuses a box outside the frame", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const e = yield* Effect.flip(
        follow({
          source: fakeSource(),
          frames: indices(0),
          box: { _tag: "Fixed", x: 300, y: 0, width: 80, height: 60 },
          outDir: dir,
          target: standard
        })
      )
      expect(e._tag).toBe("InvalidInput")
    }).pipe(Effect.scoped)
  )
})

describe("plot", () => {
  it.effect("draws one panel per track within the target, gaps and all", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const source = fakeSource()
      const image = yield* sameBytesOnRerun(
        plot({ source, tracks: ["x", "speed"], outDir: dir, target: standard })
      )
      expect(basename(image.path)).toBe("0f-09s29f.plot.x+speed.png")
      expect(image.frames.map((f) => f.address)).toEqual(["0f", "09s29f"])
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(1568)
      expect(image.tokens).toBeLessThanOrEqual(1568)
      const meta = yield* Effect.promise(() => sharp(image.path).metadata())
      expect([meta.width, meta.height]).toEqual([image.width, image.height])
    }).pipe(Effect.scoped)
  )

  it.effect("fails with the source's track names for an unknown track", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir
      const e = yield* Effect.flip(
        plot({ source: fakeSource(), tracks: ["nope"], outDir: dir, target: standard })
      )
      expect(e._tag).toBe("InvalidInput")
    }).pipe(Effect.scoped)
  )
})

describe("result schemas", () => {
  it("emit JSON Schemas for shells", () => {
    for (const schema of [ViewResult, ViewImage, FollowBox]) {
      const doc = Schema.toJsonSchemaDocument(schema)
      expect(JSON.stringify(doc)).toContain('"type"')
    }
  })
})
