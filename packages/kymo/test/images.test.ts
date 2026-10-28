/** Every image fits the byte budget an API accepts, however hard its pixels are to compress. */
import { describe, expect, it } from "@effect/vitest"
import { DEFAULT_MAX_BYTES } from "@kymo/layout"
import { frames } from "kymo"
import { Effect } from "effect"
import { mkdirSync, statSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll } from "vitest"
import { call, fresh, mediaDir } from "./harness.ts"

const media = mediaDir()
/** Four 1280x720 frames of film-grain noise over a gradient: photographic, and nearly incompressible. */
let grain = ""

const grainFrame = (seed: number) => {
  const width = 1280
  const height = 720
  const data = Buffer.alloc(width * height * 3)
  let s = seed
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        const base = ((x + y * (c + 1)) / (width + height * 3)) * 200
        data[(y * width + x) * 3 + c] = Math.max(0, Math.min(255, base + (s % 96) - 48))
      }
  return sharp(data, { raw: { width, height, channels: 3 } }).png()
}

beforeAll(async () => {
  grain = join(media.dir, "grain")
  mkdirSync(grain)
  for (let i = 0; i < 4; i++) await grainFrame(i + 1).toFile(join(grain, `f${i}.png`))
}, 60_000)
afterAll(() => media.remove())

describe("image byte budget", () => {
  it.effect("a sheet of noisy footage stays under 3.75 MB, so its base64 stays under 5 MB", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, { source: `${grain}/`, range: "0f..-1f", format: "detailed" })
      for (const sheet of out.sheets) {
        const size = statSync(sheet.path).size
        expect(sheet.bytes).toBe(size)
        expect(size).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
        expect(Math.ceil(size / 3) * 4).toBeLessThan(5 * 1024 * 1024)
        const meta = yield* Effect.promise(() => sharp(sheet.path).metadata())
        expect([meta.format, meta.width, meta.height]).toEqual(["png", sheet.width, sheet.height])
      }
    }).pipe(Effect.provide(fresh))
  )

  it.effect("a custom maxBytes is honoured, scaling the sheet down when a palette is not enough", () =>
    Effect.gen(function* () {
      const target = { maxEdge: 2576, maxTokens: 4784, maxBytes: 300_000 }
      const out = yield* call(frames, { source: `${grain}/`, range: "0f..-1f", target, format: "detailed" })
      const sheet = out.sheets[0]!
      expect(statSync(sheet.path).size).toBeLessThanOrEqual(300_000)
      expect(sheet.tokens).toBeLessThanOrEqual(4784)
    }).pipe(Effect.provide(fresh))
  )
})
