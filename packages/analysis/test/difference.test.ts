import { describe, expect, it } from "@effect/vitest"
import { frameDifferences } from "@kymo/analysis"
import { RgbImage, type Source, frameIndex } from "@kymo/core"
import { Effect, Stream } from "effect"
import { fakeSource } from "./fake.ts"

describe("frameDifferences", () => {
  it.effect("is zero where two sources match and grows where they differ, per frame", () =>
    Effect.gen(function* () {
      const a = fakeSource({ frames: 10, scene: () => ({ background: [100, 100, 100] }) })
      const b = fakeSource({
        frames: 10,
        scene: (i) => ({ background: i < 5 ? [100, 100, 100] : [200, 200, 200] })
      })
      const diffs = yield* frameDifferences(a, b, [
        frameIndex(0),
        frameIndex(4),
        frameIndex(5),
        frameIndex(9)
      ])
      expect(diffs.map((d) => d.address)).toEqual(["0f", "4f", "5f", "9f"])
      expect(diffs.map((d) => d.meanDiff)).toEqual([0, 0, 0.392157, 0.392157])
    })
  )

  it.effect("compares sources of different sizes on A's grid", () =>
    Effect.gen(function* () {
      const a = fakeSource({ frames: 2, scene: () => ({ background: [50, 50, 50] }) })
      const small: Source = {
        ...a,
        readFrames: (indices) =>
          Stream.fromIterable(indices).pipe(
            Stream.map((index) => ({ index, t: 0, image: RgbImage.blank(32, 24, [50, 50, 50]) }))
          )
      }
      const [d] = yield* frameDifferences(a, small, [frameIndex(1)])
      expect(d).toMatchObject({ address: "1f", index: 1, meanDiff: 0 })
    })
  )
})
