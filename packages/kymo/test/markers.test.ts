/** Handles and saved markers are stable: nothing an agent has been told is renamed, moved or lost. */
import { describe, expect, it } from "@effect/vitest"
import { open, probe, scan } from "kymo"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll } from "vitest"
import { call, failure, fresh, mediaDir } from "./harness.ts"

const media = mediaDir()
/** 60 frames at 30 fps: six flat shots, so hard cuts at #10, #20, #30, #40 and #50. */
let shots = ""
const COLORS = ["#d02020", "#20d020", "#2020d0", "#d0d020", "#20d0d0", "#d020d0"]

beforeAll(async () => {
  shots = join(media.dir, "shots")
  mkdirSync(shots)
  for (let i = 0; i < 60; i++)
    await sharp({ create: { width: 64, height: 36, channels: 3, background: COLORS[Math.floor(i / 10)]! } })
      .png()
      .toFile(join(shots, `f${String(i).padStart(3, "0")}.png`))
}, 30_000)
afterAll(() => media.remove())

const cutsOf = (markers: ReadonlyArray<{ readonly name: string; readonly index: number }>) =>
  Object.fromEntries(markers.filter((m) => m.name.startsWith("cut")).map((m) => [m.name, m.index]))

describe("scan markers", () => {
  it.effect("a ranged scan keeps every saved cut's name and frame, and reports cuts by those names", () =>
    Effect.gen(function* () {
      const full = yield* call(scan, { source: `${shots}/`, budget: 6 })
      expect(full.cuts.map((c) => [c.name, c.address])).toEqual([
        ["cut1", "10f"],
        ["cut2", "20f"],
        ["cut3", "01s"],
        ["cut4", "01s10f"],
        ["cut5", "01s20f"]
      ])
      const before = cutsOf((yield* call(probe, { source: full.handle })).markers)
      const ranged = yield* call(scan, { source: full.handle, range: "@cut2..@cut4", budget: 4 })
      expect(ranged.cuts.map((c) => [c.name, c.address])).toEqual([
        ["cut2", "20f"],
        ["cut3", "01s"],
        ["cut4", "01s10f"]
      ])
      const after = (yield* call(probe, { source: full.handle })).markers
      expect(cutsOf(after)).toEqual(before)
      expect(after.find((m) => m.name === "cut4")).toMatchObject({ index: 40, origin: "cut" })
    }).pipe(Effect.provide(fresh))
  )
})

describe("handles", () => {
  it.effect("reusing a taken handle for another input fails and keeps the source and its markers", () =>
    Effect.gen(function* () {
      yield* call(open, { src: `${shots}/`, as: "hero" })
      yield* call(scan, { source: "hero", budget: 4 })
      const taken = yield* failure(open, { src: "synthetic:bounce", as: "hero" })
      expect(taken._tag).toBe("InvalidInput")
      expect(taken.message).toContain("hero already names")
      expect(taken.message).toContain("saved markers")
      expect(taken.hint).toContain("hero1")
      expect(taken.hint).toContain("--replace")
      const viaProbe = yield* failure(probe, { source: "synthetic:bounce", as: "hero" })
      expect(viaProbe._tag).toBe("InvalidInput")
      const still = yield* call(probe, { source: "hero" })
      expect(still.input).toContain(shots)
      expect((yield* call(probe, { source: "hero", as: "hero" })).markers).toEqual(still.markers)
      expect(still.markers.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("the same input again is a no-op, and replace rebinds on purpose", () =>
    Effect.gen(function* () {
      yield* call(open, { src: "synthetic:cut", as: "hero" })
      yield* call(scan, { source: "hero", budget: 4 })
      const again = yield* call(open, { src: "synthetic:cut", as: "hero" })
      expect(again.timeline.markers.some((m) => m.origin === "cut")).toBe(true)
      const replaced = yield* call(open, { src: "synthetic:bounce", as: "hero", replace: true })
      expect(replaced.timeline.input).toBe("synthetic:bounce")
      expect(replaced.timeline.markers.some((m) => m.origin === "cut")).toBe(false)
    }).pipe(Effect.provide(fresh))
  )
})
