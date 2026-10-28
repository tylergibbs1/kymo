import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { FrameRange, detectCuts, parseBudget, sample, scan } from "@kymo/analysis"
import { type Scene, fakeSource, texturedSquare } from "./fake.ts"

const budget = (n: number) => Result.getOrThrow(parseBudget(n))

const analyse = (source: ReturnType<typeof fakeSource>) =>
  Effect.gen(function* () {
    const range = yield* FrameRange.whole(source.timeline)
    const s = yield* scan(source, range)
    return { range, scan: s, cuts: detectCuts(s) }
  })

const black: Scene = { background: [0, 0, 0] }
/** A still slide: dark and light alternate, with a white block that moves from slide to slide. */
const slide = (n: number): Scene => ({
  background: n % 2 === 0 ? [40, 50, 90] : [200, 190, 160],
  rects: [{ x: 4 + 5 * n, y: 12, w: 10, h: 16, rgb: [250, 250, 250] }]
})
/** A shot where a textured square moves across a textured background. */
const moving = (i: number): Scene => ({
  background: [70, 90, 70],
  texture: 20,
  rects: texturedSquare(2 + i, 18, 12)
})

describe("motion sampling", () => {
  it.effect("names the cuts it has no room for", () =>
    Effect.gen(function* () {
      const source = fakeSource({ frames: 100, scene: (i) => slide(Math.floor(i / 10)) })
      const { scan: s, cuts } = yield* analyse(source)
      expect(cuts.cuts).toHaveLength(9)
      const picked = sample({ strategy: "motion", scan: s, cuts, budget: budget(6) })
      expect(picked.frames).toHaveLength(6)
      expect(picked.omittedCuts.length).toBeGreaterThan(0)
      // Every cut's new shot is on the sheet before the next cut, or the cut is named as left out.
      cuts.cuts.forEach((c, n) => {
        const end = cuts.cuts[n + 1]?.from.index ?? s.range.last
        const shown = picked.frames.some((f) => f.index >= c.incoming.index && f.index <= end)
        const omitted = picked.omittedCuts.some((o) => o.marker.name === c.marker.name)
        expect(shown !== omitted).toBe(true)
      })
    })
  )

  it.effect("keeps room for motion when there are more cuts than frames", () =>
    Effect.gen(function* () {
      // Nine cuts between still slides, then two seconds of motion.
      const source = fakeSource({
        frames: 150,
        scene: (i) => (i < 90 ? slide(Math.floor(i / 10)) : moving(i - 90))
      })
      const { scan: s, cuts } = yield* analyse(source)
      const picked = sample({ strategy: "motion", scan: s, cuts, budget: budget(8) }).frames.map(
        (f) => f.index
      )
      expect(picked.filter((i) => i > 91 && i < 149).length).toBeGreaterThanOrEqual(2)
    })
  )

  it.effect("shows a black frame once, however many cuts land on black", () =>
    Effect.gen(function* () {
      // Black, a shot, black, another shot, black.
      const source = fakeSource({
        frames: 100,
        scene: (i) => (i < 10 || (i >= 40 && i < 50) || i >= 90 ? black : moving(i % 40))
      })
      const { scan: s, cuts } = yield* analyse(source)
      const picked = sample({ strategy: "motion", scan: s, cuts, budget: budget(8) }).frames
      expect(picked).toHaveLength(8)
      const blacks = picked.filter((f) => s.frames[f.index - s.range.first]!.luma! < 0.03)
      expect(blacks).toHaveLength(1)
    })
  )

  it.effect("does not spend the budget around a one-frame flash", () =>
    Effect.gen(function* () {
      // A small box slides along a page the whole time; frame 60 flashes white.
      const page = (i: number): Scene => ({
        background: [235, 235, 240],
        rects: [{ x: 4 + i * 0.4, y: 20, w: 6, h: 6, rgb: [40, 90, 200] }]
      })
      const source = fakeSource({
        frames: 120,
        scene: (i) => (i === 60 ? { background: [255, 255, 255] } : page(i))
      })
      const { scan: s, cuts } = yield* analyse(source)
      expect(cuts.cuts).toEqual([])
      const picked = sample({ strategy: "motion", scan: s, cuts, budget: budget(12) }).frames.map(
        (f) => f.index
      )
      expect(picked.filter((i) => Math.abs(i - 60) <= 3).length).toBeLessThanOrEqual(2)
    })
  )
})

describe("cut sampling", () => {
  it.effect("names the cuts it has no room for", () =>
    Effect.gen(function* () {
      const source = fakeSource({ frames: 100, scene: (i) => slide(Math.floor(i / 10)) })
      const { range, cuts } = yield* analyse(source)
      const picked = sample({ strategy: "cuts", range, cuts, budget: budget(6) })
      expect(picked.omittedCuts.length).toBeGreaterThan(0)
      const shown = new Set(picked.frames.map((f) => f.index))
      for (const c of picked.omittedCuts) expect(shown.has(c.marker.index)).toBe(false)
    })
  )
})
