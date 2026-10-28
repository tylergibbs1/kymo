import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { FrameRange, check, detectCuts, motionEnergy, scan } from "@kymo/analysis"
import { type Scene, fakeSource } from "./fake.ts"

/** A light page with one small box on it: most of the frame never changes, as in a UI recording. */
const page = (x: number): Scene => ({
  background: [236, 236, 240],
  rects: [{ x, y: 20, w: 4, h: 4, rgb: [40, 90, 200] }]
})

const timing = (scene: (i: number) => Scene, frames: number) =>
  Effect.gen(function* () {
    const source = fakeSource({ frames, fps: 60, scene })
    const range = yield* FrameRange.whole(source.timeline)
    const report = yield* check({ source, range, rules: ["duplicate-frames", "dropped-frames"] })
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

  it.effect("a turnaround, where the velocity crosses zero, is not a held frame", () =>
    Effect.gen(function* () {
      // Swings back and forth, drawn sub-pixel: at each extreme the box barely moves for a frame.
      const { findings } = yield* timing((i) => page(30 + 20 * Math.sin((2 * Math.PI * i) / 48)), 120)
      expect(findings).toEqual([])
    })
  )
})
