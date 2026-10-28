import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { frameIndex } from "@kymo/core"
import { FrameRange, parseAssertion, parseRules, runAssertions } from "@kymo/analysis"
import { fakeSource, trackOf } from "./fake.ts"

const frames = 90
const source = fakeSource({
  frames,
  size: null,
  scene: () => ({ background: [0, 0, 0] }),
  // Opacity ramps 0..1 over 0f..15f; box.x moves 15px/frame.
  tracks: [
    trackOf("#hero.opacity", frames, (i) => Math.min(1, i / 15)),
    trackOf("box.x", frames, (i) => i * 15)
  ],
  markers: [{ name: "impact", index: frameIndex(45), address: "01s15f", origin: "truth" }]
})
// Supplied by an earlier analysis rather than the source.
const motion = trackOf("motion", frames, (i) => (i <= 50 ? 0.05 : 0.001))
const settle = { name: "settle", index: frameIndex(50), address: "01s20f", origin: "agent" as const }

const run = (...assertions: Array<string>) =>
  runAssertions({ source, assertions, tracks: [motion], markers: [settle] })

describe("assertions", () => {
  it.effect("pass and fail against tracks and markers", () =>
    Effect.gen(function* () {
      const results = yield* run(
        "#hero.opacity >= 0.99 by 500ms",
        "#hero.opacity >= 0.99 by 200ms",
        "box.x <= 600 at 1s",
        "box.x <= 600 at 1.5s",
        "@impact within #40..#50",
        "@impact within #10..#20",
        "motion < 0.01 after @settle",
        "motion < 0.01 after @impact-2f",
        "box.x>=0"
      )
      expect(results.map((r) => r.pass)).toEqual([true, false, true, false, true, false, true, false, true])
      const [, lateFade, , tooFar, , , , early] = results
      expect(lateFade).toMatchObject({ observed: 0.4, address: "6f" })
      expect(tooFar).toMatchObject({ observed: 675, address: "01s15f" })
      expect(tooFar!.message).toContain("not <= 600")
      expect(early).toMatchObject({ observed: 0.05, address: "01s14f" })
      expect(results[4]).toMatchObject({ observed: 45, address: "01s15f" })
    })
  )

  it.effect("a missing marker subject fails the assertion rather than erroring", () =>
    Effect.gen(function* () {
      const [r] = yield* run("@landing before 2s")
      expect(r).toMatchObject({ pass: false, observed: null })
      expect(r!.message).toContain("@impact")
    })
  )

  it("malformed text gives a fixable error with an example", () => {
    const bad = (text: string) => {
      const r = parseAssertion(text)
      if (Result.isSuccess(r)) throw new Error(`${text} parsed`)
      return r.failure
    }
    expect(bad("box.x <= at 1s")).toMatchObject({ _tag: "InvalidInput" })
    expect(bad("box.x <= at 1s").hint).toContain("box.x <= 600 at 1s")
    expect(bad("box.x <= 600 at 1q")._tag).toBe("AddressParseError")
    expect(bad("box.x <= 600 at 1q").message).toContain("box.x <= 600 at 1q")
    expect(bad("box.x <= 600 during 1s").hint).toContain("during 1s..2s")
    expect(bad("box.x <= 600 at 1s..2s").message).toContain("takes one frame")
    expect(bad("box.x <= 600 soon 1s").message).toContain("at, by, after, before, during")
    expect(bad("@impact near #40").message).toContain("within, at, before, after")
    expect(bad("").hint).toContain("@impact within #40..#50")
  })

  it.effect("an unknown track lists the ones that exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run("#hero.opacty >= 1"))
      expect(error._tag).toBe("InvalidInput")
      expect(error.message).toContain("#hero.opacity")
      expect(error.message).toContain("motion")
    })
  )

  it.effect("an out-of-range operand is an AddressOutOfRange", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run("box.x <= 600 at 10s"))
      expect(error._tag).toBe("AddressOutOfRange")
    })
  )
})

describe("boundary parsing", () => {
  it("unknown rules list the valid ones", () => {
    const r = parseRules(["flicker", "jitter"])
    expect(Result.isFailure(r) && r.failure.message).toContain("jitter")
    expect(Result.isFailure(r) && r.failure.message).toContain("duplicate-frames, dropped-frames, flicker")
    expect(parseRules(["flicker", "black-frames"])).toEqual(Result.succeed(["flicker", "black-frames"]))
  })

  it.effect("ranges are contiguous and resolve through core addresses", () =>
    Effect.gen(function* () {
      const r = yield* FrameRange.parse(source.timeline, "1s..@impact")
      expect([r.first, r.last, r.count]).toEqual([30, 45, 16])
      const stepped = yield* Effect.flip(FrameRange.parse(source.timeline, "1s..2s:2f"))
      expect(stepped.hint).toBe("Drop the step: 1s..2s")
      const outside = yield* Effect.flip(FrameRange.parse(source.timeline, "1s..9s"))
      expect(outside._tag).toBe("AddressOutOfRange")
    })
  )
})
