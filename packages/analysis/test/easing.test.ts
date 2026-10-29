import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { FrameRange, type LostSpan, type Unfit, fitEasing } from "@kymo/analysis"
import type { Track } from "@kymo/core"
import { bezierCurve, fakeSource } from "./fake.ts"

const easeInOut = bezierCurve(0.42, 0, 0.58, 1)
const easeOut = bezierCurve(0, 0, 0.58, 1)
const frames = 60
const source = fakeSource({ frames, scene: () => ({ background: [0, 0, 0] }) })

/** A measured px track: rest at 100 until frame 10, `curve` to 300 by frame 40, rest after. */
const px = (f: (i: number) => number | null): Track => ({
  name: "box.x",
  unit: "px",
  samples: Array.from({ length: frames }, (_, i) => f(i))
})
const moving = (curve: (x: number) => number) => (i: number) =>
  100 + 200 * curve(Math.min(1, Math.max(0, (i - 10) / 30)))

const lostSpan = (range: FrameRange, from: number, to: number, reason: LostSpan["reason"]): LostSpan => ({
  from: range.ref(from),
  to: range.ref(to),
  reason
})

const unfit = (r: Result.Result<unknown, Unfit>): Unfit => {
  if (Result.isSuccess(r)) throw new Error(`expected no fit, got ${JSON.stringify(r.success)}`)
  return r.failure
}

describe("easing fit only fits a motion seen whole", () => {
  it.effect("a motion whose box was lost mid-way is partial, and says from where", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const curve = moving(easeInOut)
      const track = px((i) => (i < 20 ? curve(i) : null))
      const r = unfit(fitEasing(track, range, { lost: [lostSpan(range, 20, 59, "low-confidence")] }))
      expect(r.status).toBe("partial")
      expect(r.from?.index).toBe(20)
      expect(r.reason).toContain("lost from 20f")
    })
  )

  it.effect("nulls with no reason are unknown, so they also make a motion partial", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const curve = moving(easeInOut)
      expect(
        unfit(
          fitEasing(
            px((i) => (i === 25 ? null : curve(i))),
            range
          )
        ).status
      ).toBe("partial")
    })
  )

  it.effect("a subject that leaves the frame mid-motion gets its whole curve, with the end estimated", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const curve = moving(easeInOut)
      // Visible until it passes 260 (frame 32), then outside the frame.
      const track = px((i) => (curve(i) <= 260 ? curve(i) : null))
      const lostFrom = track.samples.findIndex((v) => v === null)
      const r = Result.getOrThrow(fitEasing(track, range, { lost: [lostSpan(range, lostFrom, 59, "edge")] }))
      expect([r.start, r.end]).toEqual(["rest", "disappeared"])
      expect(r.best.family).toBe("ease-in-out")
      expect(r.from.index).toBe(10)
      expect(Math.abs(r.to.index - 40)).toBeLessThanOrEqual(1)
      expect(Math.abs(r.endValue - 300)).toBeLessThan(2)
    })
  )

  it.effect("a subject that leaves the frame at constant speed has no determined end: partial", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const curve = moving((x) => x)
      const track = px((i) => (curve(i) <= 220 ? curve(i) : null))
      const lostFrom = track.samples.findIndex((v) => v === null)
      const r = unfit(fitEasing(track, range, { lost: [lostSpan(range, lostFrom, 59, "edge")] }))
      expect(r.status).toBe("partial")
      expect(r.reason).toContain("the end of the motion is not determined")
    })
  )

  it.effect("a subject that fades in mid-motion starts at its last invisible frame, value estimated", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const curve = moving(easeOut)
      // Invisible up to frame 10 (where it starts moving), then seen.
      const track = px((i) => (i <= 10 ? null : curve(i)))
      const r = Result.getOrThrow(fitEasing(track, range, { lost: [lostSpan(range, 0, 10, "faded")] }))
      expect([r.start, r.end]).toEqual(["appeared", "rest"])
      expect(r.best.family).toBe("ease-out")
      expect([r.from.index, r.to.index]).toEqual([10, 40])
      expect(Math.abs(r.startValue - 100)).toBeLessThan(1)
    })
  )
})

describe("easing fit never invents a curve", () => {
  it.effect("sub-pixel jitter on a still axis is no motion", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const jitter = px((i) => 280 + 0.11 * Math.sin(i * 1.7))
      const r = unfit(fitEasing(jitter, range))
      expect(r.status).toBe("no-motion")
      expect(r.reason).toContain("2 px")
      expect(
        unfit(
          fitEasing(
            px((i) => (i < 30 ? 80 : 80.05)),
            range
          )
        ).status
      ).toBe("no-motion")
    })
  )

  it.effect("a 0..1 track needs at least 0.02 of travel", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const small: Track = {
        name: "box.opacity",
        unit: "0..1",
        samples: Array.from({ length: frames }, (_, i) => (i < 30 ? 0.5 : 0.51))
      }
      expect(unfit(fitEasing(small, range)).status).toBe("no-motion")
    })
  )

  it.effect("a dip that returns to where it started is no motion, not a crash", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      // An opacity that wobbles below 1 while the subject moves, and comes back to 1.
      const dip: Track = {
        name: "box.opacity",
        unit: "ratio",
        samples: Array.from({ length: frames }, (_, i) =>
          i < 10 || i > 40 ? 1 : i % 3 === 0 ? 0.87 : i % 3 === 1 ? 0.94 : 0.89
        )
      }
      const r = unfit(fitEasing(dip, range))
      expect(r.status).toBe("no-motion")
      expect(r.reason).toContain("returns")
    })
  )

  it.effect("a motion over fewer than 6 frames has too few samples to fit", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const jump = px((i) => (i < 10 ? 100 : i === 10 ? 160 : i === 11 ? 240 : 300))
      const r = unfit(fitEasing(jump, range))
      expect(r.status).toBe("too-few-samples")
    })
  )

  it.effect("a track lost in every frame says so, not that it does not change", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const anchorOnly = px((i) => (i === 0 ? 400 : null))
      const r = unfit(fitEasing(anchorOnly, range, { lost: [lostSpan(range, 1, 59, "low-confidence")] }))
      expect(r.status).toBe("lost")
      expect(r.reason).not.toContain("change")
      expect(
        unfit(
          fitEasing(
            px(() => null),
            range,
            { lost: [lostSpan(range, 0, 59, "edge")] }
          )
        ).status
      ).toBe("lost")
    })
  )
})
