import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { FrameRange, type RegionTrack, trackRegion } from "@kymo/analysis"
import { H, W, fakeSource, texturedSquare } from "./fake.ts"

/** Frames where `region` has a position more than `tolerance` px from `truth`, or none at all. */
const misses = (
  region: RegionTrack,
  frames: ReadonlyArray<number>,
  truth: (i: number) => { x: number; y: number },
  tolerance = 1
) =>
  frames.filter((i) => {
    const x = region.x.samples[i]
    const y = region.y.samples[i]
    return (
      x == null || y == null || Math.abs(x - truth(i).x) > tolerance || Math.abs(y - truth(i).y) > tolerance
    )
  })

const lostAt = (region: RegionTrack, i: number) =>
  region.lost.find((l) => l.from.index <= i && i <= l.to.index)

describe("tracking a subject that fades in", () => {
  // A 14px square on a plain background, moving right 1px a frame and fading in over frames 6..20.
  const pos = (i: number) => ({ x: 10 + i, y: 18 })
  const opacity = (i: number) => Math.max(0, Math.min(1, (i - 5) / 15))
  const fading = fakeSource({
    frames: 31,
    scene: (i) => ({ background: [70, 90, 80], rects: texturedSquare(pos(i).x, pos(i).y, 14, opacity(i)) })
  })
  const visible = Array.from({ length: 31 }, (_, i) => i).filter((i) => opacity(i) >= 0.1)

  it.effect("follows it from a faint first frame", () =>
    Effect.gen(function* () {
      const range = (yield* FrameRange.whole(fading.timeline)).clamp(7, 30)
      const region = yield* trackRegion(fading, range, { ...pos(7), w: 14, h: 14 })
      expect(misses(region, visible, pos)).toEqual([])
      expect(region.lost).toEqual([])
    })
  )

  it.effect("follows it backwards from the frame it is fully visible, and says where it faded", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(fading.timeline)
      const region = yield* trackRegion(fading, range, { ...pos(25), w: 14, h: 14 }, { anchor: 25 })
      expect(region.anchor?.index).toBe(25)
      expect(misses(region, visible, pos)).toEqual([])
      for (let i = 0; i <= 5; i++) expect(lostAt(region, i)?.reason, `frame ${i}`).toBe("faded")
    })
  )

  it.effect("rejects an anchor outside the range", () =>
    Effect.gen(function* () {
      const range = (yield* FrameRange.whole(fading.timeline)).clamp(0, 10)
      const error = yield* Effect.flip(
        trackRegion(fading, range, { ...pos(25), w: 14, h: 14 }, { anchor: 25 })
      )
      expect(error._tag).toBe("InvalidInput")
    })
  )
})

describe("tracking a subject leaving the frame", () => {
  // A 14px square moving right 3px a frame, off the right edge (x = 64) from frame 12.
  const pos = (i: number) => ({ x: 20 + 3 * i, y: 18 })
  const leaving = fakeSource({
    frames: 20,
    scene: (i) => ({ background: [70, 90, 80], texture: 25, rects: texturedSquare(pos(i).x, pos(i).y, 14) })
  })

  it.effect("reports positions past the edge while part of it shows, then edge", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(leaving.timeline)
      const region = yield* trackRegion(leaving, range, { ...pos(0), w: 14, h: 14 })
      // At least half of it in the frame: x + 7 <= 64.
      const half = Array.from({ length: 20 }, (_, i) => i).filter((i) => pos(i).x + 7 <= W)
      expect(half.some((i) => pos(i).x + 14 > W)).toBe(true)
      expect(misses(region, half, pos)).toEqual([])
      // Gone entirely: lost at the edge, never "low-confidence".
      for (let i = 0; i < 20; i++)
        if (pos(i).x >= W) expect(lostAt(region, i)?.reason, `frame ${i}`).toBe("edge")
      expect(region.lost.every((l) => l.reason === "edge")).toBe(true)
    })
  )
})

describe("tracking a subject that scales", () => {
  // A 24px badge centred on (32, 24) with an off-centre mark, growing about its centre to 30px over
  // 12 frames (a hover scale of 1.25), drawn anti-aliased.
  const size = (i: number) => 24 + (6 * Math.min(i, 12)) / 12
  const badge = (s: number) => {
    const x = 32 - s / 2
    const y = 24 - s / 2
    return [
      { x, y, w: s, h: s, rgb: [230, 230, 230] as const },
      { x: x + 0.15 * s, y: y + 0.2 * s, w: 0.3 * s, h: 0.3 * s, rgb: [40, 160, 220] as const },
      { x: x + 0.55 * s, y: y + 0.6 * s, w: 0.3 * s, h: 0.2 * s, rgb: [220, 60, 40] as const }
    ]
  }
  const growing = fakeSource({
    frames: 13,
    scene: (i) => ({ background: [70, 90, 80], texture: 10, rects: badge(size(i)) })
  })

  it.effect("measures w and h, and keeps x, y on the scaled box", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(growing.timeline)
      const region = yield* trackRegion(growing, range, { x: 20, y: 12, w: 24, h: 24 })
      for (let i = 0; i < 13; i++) {
        expect(Math.abs(region.w.samples[i]! - size(i)), `w at ${i}`).toBeLessThanOrEqual(0.5)
        expect(Math.abs(region.h.samples[i]! - size(i)), `h at ${i}`).toBeLessThanOrEqual(0.5)
        expect(Math.abs(region.x.samples[i]! - (32 - size(i) / 2)), `x at ${i}`).toBeLessThanOrEqual(0.5)
      }
    })
  )
})

describe("tracking cost", () => {
  it.effect("decodes a large box small, so cost does not grow with it", () =>
    Effect.gen(function* () {
      // A 480x280 panel with a textured stripe, moving down 4px a frame, on a 1280x720 frame.
      const reads: Array<number | undefined> = []
      const big = fakeSource({
        frames: 26,
        size: { width: 1280, height: 720 },
        onRead: (_, options) => reads.push(options?.maxEdge),
        scene: (i) => ({
          background: [238, 241, 245],
          rects: [
            { x: 400, y: 200 + 4 * i, w: 480, h: 280, rgb: [255, 255, 255] },
            { x: 428, y: 224 + 4 * i, w: 300, h: 26, rgb: [19, 32, 61] },
            { x: 428, y: 270 + 4 * i, w: 200, h: 12, rgb: [68, 68, 85] },
            { x: 732, y: 412 + 4 * i, w: 120, h: 44, rgb: [43, 89, 195] }
          ]
        })
      })
      const range = yield* FrameRange.whole(big.timeline)
      const started = performance.now()
      const region = yield* trackRegion(big, range, { x: 400, y: 200, w: 480, h: 280 })
      const seconds = (performance.now() - started) / 1000
      expect(reads.every((e) => e !== undefined && e <= 640)).toBe(true)
      expect(misses(region, range.indices(), (i) => ({ x: 400, y: 200 + 4 * i }))).toEqual([])
      expect(seconds).toBeLessThan(3)
      expect(H).toBe(48)
    })
  )
})
