import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { FrameRange, check, detectCuts, motionEnergy, scan } from "@kymo/analysis"
import { type Scene, fakeSource } from "./fake.ts"

/** A light page with one small box on it: most of the frame never changes, as in a UI recording. */
const page = (x: number): Scene => ({
  background: [236, 236, 240],
  rects: [{ x, y: 20, w: 4, h: 4, rgb: [40, 90, 200] }]
})

/**
 * Steps taken by frame i of a stepped animation that starts after frame 5: one step a frame, none at
 * `holds` (the frame repeats), two at `skips` (a frame was dropped), stopping after `steps` steps.
 */
const stepped = (
  i: number,
  options: { holds?: ReadonlyArray<number>; skips?: ReadonlyArray<number>; steps?: number }
): number => {
  let at = 0
  for (let k = 6; k <= i; k++) {
    const inc = options.holds?.includes(k) ? 0 : options.skips?.includes(k) ? 2 : 1
    at = Math.min(options.steps ?? Infinity, at + inc)
  }
  return at
}

const timing = (scene: (i: number) => Scene, frames: number) =>
  Effect.gen(function* () {
    const source = fakeSource({ frames, fps: 60, scene })
    const range = yield* FrameRange.whole(source.timeline)
    const report = yield* check({
      labelStyle: "both",
      source,
      range,
      rules: ["duplicate-frames", "dropped-frames"]
    })
    const s = yield* scan(source, range)
    return { findings: report.findings, motion: motionEnergy(s, detectCuts(s)) }
  })

describe("motion of a small element in a large still frame", () => {
  it.effect("finds its held and skipped frames, and does not call it still", () =>
    Effect.gen(function* () {
      // 1 px per frame; frame 20 repeats frame 19, frame 40 skips a position.
      const position = (i: number) => (i < 20 ? i : i === 20 ? 19 : i < 40 ? i - 1 : i)
      const { findings, motion } = yield* timing((i) => page(4 + position(i)), 60)
      expect(findings.map((f) => [f.rule, f.index, f.severity])).toEqual([
        ["duplicate-frames", 20, "warning"],
        ["dropped-frames", 40, "warning"]
      ])
      // Only the held frame is still, though the box changes well under 1% of the frame.
      expect(motion.stillRatio).toBeLessThan(0.05)
    })
  )

  it.effect("a frame that lands two steps on after a held frame is a dropped frame", () =>
    Effect.gen(function* () {
      // Frame 25 repeats frame 24 (a late timer), and frame 26 catches up two steps: the step between
      // was never shown.
      const { findings } = yield* timing((i) => page(4 + stepped(i, { holds: [25], skips: [26] })), 60)
      expect(findings.map((f) => [f.rule, f.index])).toEqual([
        ["duplicate-frames", 25],
        ["dropped-frames", 26]
      ])
      expect(findings[1]!.message).toContain("after the hold at 25f #25")
    })
  )

  it.effect("a hold of two frames names both, and the normal step after it is not a skip", () =>
    Effect.gen(function* () {
      const { findings } = yield* timing((i) => page(4 + stepped(i, { holds: [30, 31] })), 60)
      expect(findings.map((f) => [f.rule, f.index, f.span])).toEqual([["duplicate-frames", 30, "30f..31f"]])
      expect(findings[0]!.message).toContain("30f #30")
      expect(findings[0]!.message).toContain("31f #31")
    })
  )

  it.effect("finds a skipped frame two frames before the motion stops", () =>
    Effect.gen(function* () {
      // 1 px per frame from frame 6, 50 steps in all; frame 52 skips one, and the box stops at frame 54.
      const { findings } = yield* timing((i) => page(4 + stepped(i, { skips: [52], steps: 50 })), 70)
      expect(findings.map((f) => [f.rule, f.index])).toEqual([["dropped-frames", 52]])
    })
  )

  it.effect("a turnaround, where the velocity crosses zero, is not a held frame", () =>
    Effect.gen(function* () {
      // Swings back and forth, drawn sub-pixel: at each extreme the box barely moves for a frame.
      const { findings } = yield* timing((i) => page(30 + 20 * Math.sin((2 * Math.PI * i) / 48)), 120)
      expect(findings).toEqual([])
    })
  )
})
