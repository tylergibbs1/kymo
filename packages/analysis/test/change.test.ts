/**
 * When a fixed box starts and settles, by a stated rule: against the range's first and last frames,
 * an edge moving `within.px` or more or a fade of `within.opacity` or more counts as different.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Changes, FrameRange, type Timing, type Within, boxChange } from "@kymo/analysis"
import { type Scene, fakeSource, texturedSquare } from "./fake.ts"

const size = { width: 160, height: 120 }
const PAGE: Scene["background"] = [240, 240, 240]
const BOX = { x: 50, y: 30, w: 60, h: 60 }

const frames = (t: Timing) => {
  if (t._tag === "still") throw new Error("expected the box to change")
  return { starts: t.starts.index, settles: t.settles?.index ?? null }
}

const timing = (scene: (i: number) => Scene, count: number, range?: [number, number], within?: Within) =>
  Effect.gen(function* () {
    const source = fakeSource({ frames: count, size, scene })
    const whole = yield* FrameRange.whole(source.timeline)
    const r = range === undefined ? whole : whole.clamp(range[0], range[1])
    return (yield* boxChange(source, r, BOX, within === undefined ? {} : { within })).timing
  })

/** Frames 0..59; an ease-out from frame 10 to 50 with a long, slow tail. */
const easeOut = (i: number) => 1 - (1 - Math.min(1, Math.max(0, (i - 10) / 40))) ** 3
const firstFrame = (test: (i: number) => boolean) => Array.from({ length: 60 }, (_, i) => i).find(test)!
const settleFrame = (differs: (i: number) => boolean) => {
  let i = 59
  while (i > 0 && !differs(i - 1)) i--
  return i
}

describe("change timing in a box", () => {
  it.effect("times a high-contrast fade by 2% of opacity, under the 5-level floor", () =>
    Effect.gen(function* () {
      // A dark, textured square fading in where it rests: 2% of its contrast is under 5 grey levels
      // on most of its pixels, so a per-pixel floor alone would call the tail settled too early.
      const scene = (i: number): Scene => ({
        background: PAGE,
        rects: texturedSquare(50, 30, 60, easeOut(i))
      })
      const t = frames(yield* timing(scene, 60))
      expect(Math.abs(t.starts - firstFrame((i) => easeOut(i) >= 0.02))).toBeLessThanOrEqual(1)
      expect(Math.abs(t.settles! - settleFrame((i) => 1 - easeOut(i) >= 0.02))).toBeLessThanOrEqual(1)
      // A looser rule settles where it says, earlier.
      const loose = frames(yield* timing(scene, 60, undefined, { px: 1, opacity: 0.1 }))
      expect(Math.abs(loose.settles! - settleFrame((i) => 1 - easeOut(i) >= 0.1))).toBeLessThanOrEqual(1)
    })
  )

  it.effect("settles a slide when it stays within 1 px of where it ends, not half a pixel", () =>
    Effect.gen(function* () {
      // A square sliding 30 px right into the box, its last pixel taking many frames.
      const x = (i: number) => 20 + 30 * easeOut(i)
      // One layer, as a browser moves it: a dark square with a light stripe drawn over it.
      const scene = (i: number): Scene => ({
        background: PAGE,
        rects: [
          { x: x(i), y: 30, w: 60, h: 60, rgb: [40, 60, 120] },
          { x: x(i) + 10, y: 50, w: 30, h: 12, rgb: [250, 250, 250] }
        ]
      })
      const t = frames(yield* timing(scene, 60))
      expect(Math.abs(t.settles! - settleFrame((i) => 50 - x(i) >= 1))).toBeLessThanOrEqual(1)
    })
  )

  it.effect("never settles before it starts: a slow cross-fade cut off by the range is unsettled", () =>
    Effect.gen(function* () {
      // Two pages 12 levels apart cross-fade from frame 10 to 30, under a level per frame; the range
      // ends at 25, two thirds of the way. Against the first frame the fade shows late, against the
      // last early: a floor-only rule called it settled at 17 and started at 19.
      const pageB: Scene = { background: PAGE, rects: [{ x: 0, y: 0, w: 160, h: 120, rgb: [228, 228, 228] }] }
      const mix = (i: number) => Math.min(1, Math.max(0, (i - 10) / 20))
      const scene = (i: number): Scene => ({ background: PAGE, over: { scene: pageB, alpha: mix(i) } })
      const t = frames(yield* timing(scene, 40, [0, 25]))
      expect(t.settles).toBeNull()
      expect(t.starts).toBeLessThanOrEqual(12)
      const whole = frames(yield* timing(scene, 40))
      expect(whole.settles).not.toBeNull()
      expect(whole.settles!).toBeGreaterThanOrEqual(whole.starts)
    })
  )

  it.effect("reports a box that never changes as still", () =>
    Effect.gen(function* () {
      const t = yield* timing(() => ({ background: PAGE, rects: texturedSquare(50, 30, 60) }), 20)
      expect(t._tag).toBe("still")
    })
  )

  it("cannot be made with settles before starts", () => {
    const ref = (index: number) => ({ address: `${index}f`, index, t: index / 30 })
    expect(() =>
      Changes.make({ _tag: "changes", starts: ref(28) as never, settles: ref(25) as never })
    ).toThrow()
    expect(
      Changes.make({ _tag: "changes", starts: ref(25) as never, settles: ref(28) as never }).settles?.index
    ).toBe(28)
  })
})
