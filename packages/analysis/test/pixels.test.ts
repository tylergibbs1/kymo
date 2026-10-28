import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { FrameRange, check, detectCuts, motionEnergy, parseBudget, sample, scan } from "@kymo/analysis"
import { Result } from "effect"
import { type Scene, fakeSource, texturedSquare } from "./fake.ts"

const shotA = (x: number): Scene => ({
  background: [60, 60, 70],
  texture: 20,
  rects: texturedSquare(x, 18, 12)
})
const shotB = (x: number): Scene => ({
  background: [190, 180, 150],
  texture: 30,
  rects: texturedSquare(x, 10, 12)
})
const white: Scene = { background: [255, 255, 255] }
const black: Scene = { background: [0, 0, 0] }

const analyse = (source: ReturnType<typeof fakeSource>) =>
  Effect.gen(function* () {
    const range = yield* FrameRange.whole(source.timeline)
    const s = yield* scan(source, range)
    const cuts = detectCuts(s)
    return { range, scan: s, cuts, motion: motionEnergy(s, cuts) }
  })

describe("cuts, motion and flicker", () => {
  // Shot A moves right 1px/frame; a one-frame white flash at 20; hard cut to shot B at 50.
  const source = fakeSource({
    frames: 100,
    scene: (i) => (i === 20 ? white : i < 50 ? shotA(2 + i) : shotB(2 + (i - 50)))
  })

  it.effect("finds the hard cut at the exact frame and not at the flash", () =>
    Effect.gen(function* () {
      const { cuts } = yield* analyse(source)
      expect(cuts.cuts.map((c) => [c.kind, c.marker.name, c.marker.index, c.marker.origin])).toEqual([
        ["hard", "cut1", 50, "cut"]
      ])
      expect(cuts.cuts[0]!.from.index).toBe(49)
      expect(cuts.cuts[0]!.marker.address).toBe("01s20f")
    })
  )

  it.effect("reports a 0..1 motion track over the whole clock with peaks as markers", () =>
    Effect.gen(function* () {
      const { motion } = yield* analyse(source)
      expect(motion.track.name).toBe("motion")
      expect(motion.track.samples).toHaveLength(100)
      expect(motion.track.samples[0]).toBeNull()
      for (const v of motion.track.samples.slice(1)) expect(v).toBeGreaterThan(0)
      // The flash is the biggest change that is not a cut.
      expect(motion.peaks[0]!.marker).toMatchObject({ name: "peak1", origin: "peak" })
      expect([20, 21]).toContain(motion.peaks[0]!.marker.index)
      expect(motion.windows.length).toBeGreaterThan(0)
    })
  )

  it.effect("flags the flash as flicker at the exact frame", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const report = yield* check({ source, range, rules: ["flicker"] })
      expect(report.findings.map((f) => [f.rule, f.index, f.severity])).toEqual([["flicker", 20, "error"]])
      expect(report.findings[0]!.suggest).toEqual({
        tool: "kymo_frames",
        at: ["19f", "20f", "21f"],
        view: "diff"
      })
    })
  )

  it.effect("finds a fade between two shots", () =>
    Effect.gen(function* () {
      // Cross-fade from shot B to a dark shot over frames 40..47.
      const blend = (i: number): Scene => {
        const t = Math.min(1, Math.max(0, (i - 39) / 8))
        const c = (a: number, b: number) => Math.round(a + (b - a) * t)
        return { background: [c(190, 20), c(180, 20), c(150, 30)], texture: 20 }
      }
      const fade = fakeSource({ frames: 80, scene: blend })
      const { cuts } = yield* analyse(fade)
      expect(cuts.cuts).toHaveLength(1)
      const cut = cuts.cuts[0]!
      expect(cut.kind).toBe("fade")
      expect(cut.from.index).toBe(39)
      expect(cut.to.index).toBe(47)
    })
  )
})

describe("frame-timing rules", () => {
  // 1px/frame; frame 15 repeats frame 14; frame 30 skips a position (a dropped frame); 70..74 black.
  const position = (i: number) => (i <= 15 ? (i === 15 ? 14 : i) : i < 30 ? i - 1 : i)
  const source = fakeSource({
    frames: 90,
    scene: (i) => (i >= 70 && i <= 74 ? black : shotA(2 + (position(i) % 48)))
  })

  it.effect("finds the duplicated, dropped and black frames", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const report = yield* check({
        source,
        range,
        rules: ["duplicate-frames", "dropped-frames", "black-frames"]
      })
      expect(report.rules).toEqual(["duplicate-frames", "dropped-frames", "black-frames"])
      expect(report.findings.map((f) => [f.rule, f.index, f.span ?? null])).toEqual([
        ["duplicate-frames", 15, null],
        ["dropped-frames", 30, null],
        ["black-frames", 70, "02s10f..02s14f"]
      ])
      expect(report.findings[2]!.severity).toBe("warning")
    })
  )

  it.effect("finds a three-frame stall inside motion", () =>
    Effect.gen(function* () {
      // Moves 1px/frame but holds frames 40..42 on frame 39's picture, then jumps ahead.
      const stalled = fakeSource({
        frames: 60,
        scene: (i) => shotA(4 + (i >= 40 && i <= 42 ? 39 : i))
      })
      const range = yield* FrameRange.whole(stalled.timeline)
      const report = yield* check({ source: stalled, range, rules: ["duplicate-frames"] })
      expect(report.findings.map((f) => [f.index, f.span ?? null])).toEqual([[40, "01s10f..01s12f"]])
    })
  )

  it.effect("does not call a still shot or a pause a held frame", () =>
    Effect.gen(function* () {
      // A still shot with a one-frame flash in the middle, then a square that moves, pauses for 20
      // frames and moves on. Neither still stretch is a duplicated frame.
      const scene = (i: number): Scene =>
        i < 60
          ? i === 30
            ? white
            : shotA(4)
          : i < 70
            ? shotA(4 + (i - 60))
            : i < 90
              ? shotA(14)
              : shotA(14 + (i - 90))
      const still = fakeSource({ frames: 100, scene })
      const range = yield* FrameRange.whole(still.timeline)
      const report = yield* check({ source: still, range, rules: ["duplicate-frames"] })
      expect(report.findings).toEqual([])
    })
  )

  it.effect("rejects pixel rules on a source without pixels", () =>
    Effect.gen(function* () {
      const telemetry = fakeSource({ frames: 10, scene: () => black, size: null })
      const range = yield* FrameRange.whole(telemetry.timeline)
      const error = yield* Effect.flip(check({ source: telemetry, range, rules: ["flicker"] }))
      expect(error._tag).toBe("InvalidInput")
      expect(error.hint).toContain("rules=non-monotonic")
    })
  )
})

describe("sampling", () => {
  // Still for 60 frames, then the square moves; a hard cut at 90 inside the moving half.
  const scene = (i: number): Scene => (i < 60 ? shotA(4) : i < 90 ? shotA(4 + (i - 60)) : shotB(4 + (i - 90)))
  const source = fakeSource({ frames: 120, scene })
  const budget = Result.getOrThrow(parseBudget(12))

  it.effect("motion sampling keeps the ends and the cut and favours the moving half", () =>
    Effect.gen(function* () {
      const { scan: s, cuts } = yield* analyse(source)
      expect(cuts.cuts.map((c) => c.marker.index)).toEqual([90])
      const picks = sample({ strategy: "motion", scan: s, cuts, budget }).frames.map((r) => r.index)
      expect(picks).toHaveLength(12)
      expect(picks).toContain(0)
      expect(picks).toContain(119)
      expect(picks).toContain(90)
      const moving = picks.filter((i) => i >= 60).length
      expect(moving).toBeGreaterThan(12 - moving + 3)
      // Deterministic.
      expect(sample({ strategy: "motion", scan: s, cuts, budget }).frames.map((r) => r.index)).toEqual(picks)
    })
  )

  it.effect("even and cut sampling", () =>
    Effect.gen(function* () {
      const { range, cuts } = yield* analyse(source)
      const even = sample({ strategy: "even", range, budget: Result.getOrThrow(parseBudget(5)) }).frames
      expect(even.map((r) => r.index)).toEqual([0, 30, 60, 89, 119])
      expect(even[1]!.address).toBe("01s")
      const atCuts = sample({
        strategy: "cuts",
        range,
        cuts,
        budget: Result.getOrThrow(parseBudget(6))
      }).frames
      expect(atCuts.map((r) => r.index)).toEqual([0, 88, 89, 90, 91, 119])
    })
  )

  it("rejects a non-positive budget with a fixable error", () => {
    const r = parseBudget(0)
    expect(Result.isFailure(r) && r.failure.hint).toContain("12")
  })
})
