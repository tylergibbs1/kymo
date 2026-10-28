import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { FrameRange, check, fitEasing, parseBox, trackRegion } from "@kymo/analysis"
import { bezierCurve, fakeSource, texturedSquare, trackOf } from "./fake.ts"

const easeInOut = bezierCurve(0.42, 0, 0.58, 1)

describe("region tracking", () => {
  // A 12px textured square on a textured background, eased across and drifting down.
  const truth = (i: number) => ({ x: 4 + Math.round(46 * easeInOut(i / 40)), y: 6 + Math.round(i / 3) })
  const source = fakeSource({
    frames: 41,
    scene: (i) => ({
      background: [70, 90, 80],
      texture: 25,
      rects: texturedSquare(truth(i).x, truth(i).y, 12)
    })
  })

  it.effect("follows a moving square within 1px", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const box = Result.getOrThrow(parseBox("4,6,12,12", { width: 64, height: 48 }))
      const region = yield* trackRegion(source, range, box)
      expect(region.x.name).toBe("box.x")
      expect(region.method).toBe("template")
      for (let i = 0; i <= 40; i++) {
        expect(Math.abs(region.x.samples[i]! - truth(i).x)).toBeLessThanOrEqual(1)
        expect(Math.abs(region.y.samples[i]! - truth(i).y)).toBeLessThanOrEqual(1)
        expect(region.w.samples[i]).toBe(12)
        expect(region.confidence.samples[i]!).toBeGreaterThan(0.8)
      }
    })
  )

  it.effect("flags the region leaving the safe area", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const region = yield* trackRegion(source, range, { x: 4, y: 6, w: 12, h: 12 }, { name: "logo" })
      // 5% of 48px = 2.4px top margin, of 64px = 3.2px: x=4 is safe; x+w beyond 60.8 is not.
      const report = yield* check({ source, range, rules: ["safe-area"], regions: [region] })
      expect(report.findings).toHaveLength(1)
      const f = report.findings[0]!
      expect(f.rule).toBe("safe-area")
      expect(region.x.samples[f.index]! + 12).toBeGreaterThan(60.8)
      expect(region.x.samples[f.index - 1]! + 12).toBeLessThanOrEqual(60.8)
      expect(f.message).toContain("logo")
    })
  )

  it("rejects a box outside the frame with an example", () => {
    const r = parseBox("60,40,12,12", { width: 64, height: 48 })
    expect(Result.isFailure(r) && r.failure.hint).toContain("e.g. 120,80,64,64")
    expect(Result.isFailure(parseBox("1,2,3", { width: 64, height: 48 }))).toBe(true)
  })
})

describe("easing fit", () => {
  const frames = 60
  // Rest at 100 until frame 10, move to 300 by frame 40, rest after.
  const segment = (curve: (x: number) => number) =>
    trackOf("box.x", frames, (i) => 100 + 200 * curve(Math.min(1, Math.max(0, (i - 10) / 30))))
  const source = fakeSource({ frames, scene: () => ({ background: [0, 0, 0] }) })

  const fit = (track: ReturnType<typeof trackOf>, fps = 30) =>
    Effect.gen(function* () {
      const s =
        fps === 30
          ? source
          : fakeSource({ frames: track.samples.length, fps, scene: () => ({ background: [0, 0, 0] }) })
      const range = yield* FrameRange.whole(s.timeline)
      return Result.getOrThrow(fitEasing(track, range))
    })

  it.effect("picks linear for a linear move and finds its ends", () =>
    Effect.gen(function* () {
      const r = yield* fit(segment((x) => x))
      expect(r.best.family).toBe("linear")
      expect([r.from.index, r.to.index]).toEqual([10, 40])
      expect(r.durationFrames).toBe(30)
      expect(r.durationSeconds).toBe(1)
      expect([r.startValue, r.endValue]).toEqual([100, 300])
      expect(r.candidates).toHaveLength(7)
    })
  )

  it.effect("picks ease-in-out for the CSS ease-in-out curve", () =>
    Effect.gen(function* () {
      const r = yield* fit(segment(easeInOut))
      expect(r.best.family).toBe("ease-in-out")
      expect([r.from.index, r.to.index]).toEqual([10, 40])
    })
  )

  it.effect("picks spring for a damped oscillation and recovers its parameters", () =>
    Effect.gen(function* () {
      const zeta = 0.3
      const omega = 2 * Math.PI * 2
      const wd = omega * Math.sqrt(1 - zeta * zeta)
      const spring = (t: number) =>
        t <= 0
          ? 0
          : 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t))
      const track = trackOf("#hero.scale", 150, (i) => 0.5 + 0.5 * spring((i - 10) / 60))
      const r = yield* fit(track, 60)
      expect(r.best.family).toBe("spring")
      if (r.best.family !== "spring") return
      expect(r.best.dampingRatio).toBeCloseTo(0.3, 1)
      expect(r.best.frequencyHz).toBeCloseTo(2, 1)
      expect(r.from.index).toBe(10)
    })
  )

  it.effect("explains a track that never moves", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const r = fitEasing(
        trackOf("flat", frames, () => 5),
        range
      )
      expect(Result.isFailure(r) && r.failure.hint).toContain("0f..-1f")
    })
  )
})

describe("non-monotonic", () => {
  it.effect("finds an opacity that dips on its way up, but not a spring that overshoots", () =>
    Effect.gen(function* () {
      const source = fakeSource({ frames: 40, scene: () => ({ background: [0, 0, 0] }), size: null })
      const range = yield* FrameRange.whole(source.timeline)
      const dips = trackOf("#hero.opacity", 40, (i) => (i === 12 ? 0.2 : Math.min(1, i / 20)))
      const overshoot = trackOf("#card.y", 40, (i) => (i < 10 ? i * 11 : i < 15 ? 110 - (i - 10) * 2 : 100))
      const report = yield* check({ source, range, tracks: [dips, overshoot] })
      expect(report.rules).toEqual(["non-monotonic"])
      expect(report.findings.map((f) => [f.rule, f.index])).toEqual([["non-monotonic", 12]])
      expect(report.findings[0]!.message).toContain("#hero.opacity")
    })
  )
})
