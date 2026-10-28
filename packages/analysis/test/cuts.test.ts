import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { FrameRange, detectCuts, scan } from "@kymo/analysis"
import { type Scene, fakeSource } from "./fake.ts"

/** A dark chat page: a faint line of text streams in every five frames. */
const chat = (i: number): Scene => ({
  background: [26, 26, 26],
  rects: Array.from({ length: Math.min(3, 1 + Math.floor(i / 5)) }, (_, r) => ({
    x: 6,
    y: 6 + 4 * r,
    w: 24 + 3 * r,
    h: 1,
    rgb: [70, 70, 70] as const
  }))
})
/** A title card a shade darker, with one short line of white text: barely different on average. */
const title: Scene = {
  background: [22, 22, 22],
  rects: [{ x: 22, y: 24, w: 20, h: 1, rgb: [220, 220, 220] }]
}

describe("cuts in a screen recording", () => {
  it.effect("finds a title card in a dark UI, though it moves the frame's mean little", () =>
    Effect.gen(function* () {
      const source = fakeSource({ frames: 60, scene: (i) => (i < 40 ? chat(i) : title) })
      const range = yield* FrameRange.whole(source.timeline)
      const s = yield* scan(source, range)
      expect(s.frames[40]!.motion!).toBeLessThan(0.03)
      expect(detectCuts(s).cuts.map((c) => [c.kind, c.marker.index])).toEqual([["hard", 40]])
    })
  )

  it.effect("finds every cut of a slideshow, where nothing moves but the cuts", () =>
    Effect.gen(function* () {
      const slide = (n: number): Scene => ({
        background: [40 + 50 * (n % 4), 60, 200 - 40 * (n % 4)],
        rects: [{ x: 8 + 9 * n, y: 10, w: 12, h: 20, rgb: [250, 250, 250] }]
      })
      const source = fakeSource({ frames: 60, scene: (i) => slide(Math.floor(i / 10)) })
      const range = yield* FrameRange.whole(source.timeline)
      const s = yield* scan(source, range)
      expect(detectCuts(s).cuts.map((c) => c.marker.index)).toEqual([10, 20, 30, 40, 50])
    })
  )
})
