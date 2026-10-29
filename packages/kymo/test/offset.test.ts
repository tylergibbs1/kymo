/**
 * `open --offset` says how many frames a source runs late; compare pairs frames through it, so the
 * same address names the same moment on both sources.
 */
import { describe, expect, it } from "@effect/vitest"
import { compare, open, probe } from "kymo"
import { Effect } from "effect"
import { call, failure, fresh, freshStyled } from "./harness.ts"

/** The same linear move, B starting it 6 frames later: B's frame i + 6 shows A's frame i. */
const A = "synthetic:ease?easing=linear&frames=60&start=10&end=40"
const B = "synthetic:ease?easing=linear&frames=60&start=16&end=46"
const DELAY = 6

describe("compare with an offset", () => {
  it.effect(
    "a positive offset on B pairs A's frame i with B's frame i + offset, so a delayed copy matches",
    () =>
      Effect.gen(function* () {
        const a = yield* call(open, { src: A })
        const b = yield* call(open, { src: B, offset: DELAY })
        expect(b.offset).toBe(DELAY)
        const out = yield* call(compare, { a: a.handle, b: b.handle, view: "diff" })
        expect(out.offsets).toEqual({ a: 0, b: DELAY })
        expect(out.bFrames.map((f) => f.index)).toEqual(out.frames.map((f) => f.index + DELAY))
        expect(out.summary).toMatchObject({ max: 0, changed: 0 })
        expect(out.sheets[0]!.label).toContain(`${a.handle} vs ${b.handle} (${b.handle} +${DELAY}f)`)
        // A's last six frames have no B frame at the same moment: said, not silently dropped.
        expect(out.frames).toHaveLength(60 - DELAY)
        expect(out.warnings).toEqual([
          `${a.handle} 01s24f..01s29f (6 frames) have no ${b.handle} frame at the same moment with ${b.handle}'s offset of +6f, so they were not compared.`
        ])
      }).pipe(Effect.provide(fresh))
  )

  it.effect("the warning names the frames left out in the label style, so index style says #54..#59", () =>
    Effect.gen(function* () {
      const a = yield* call(open, { src: A })
      const b = yield* call(open, { src: B, offset: DELAY })
      const out = yield* call(compare, { a: a.handle, b: b.handle, view: "diff" })
      expect(out.warnings).toEqual([
        `${a.handle} #54..#59 (6 frames) have no ${b.handle} frame at the same moment with ${b.handle}'s offset of +6f, so they were not compared.`
      ])
    }).pipe(Effect.provide(freshStyled("index")))
  )

  it.effect("a zero offset pairs by index, so the delay shows as a difference", () =>
    Effect.gen(function* () {
      const a = yield* call(open, { src: A })
      yield* call(open, { src: B, offset: DELAY })
      const b = yield* call(open, { src: B, offset: 0 })
      const out = yield* call(compare, { a: a.handle, b: b.handle, view: "diff" })
      expect(out.offsets).toEqual({ a: 0, b: 0 })
      expect(out.bFrames.map((f) => f.index)).toEqual(out.frames.map((f) => f.index))
      expect(out.summary.changed).toBeGreaterThan(20)
      expect(out.warnings).toBeUndefined()
      expect(out.sheets[0]!.label).not.toContain("+")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("offsets on both sides are relative, and an address on B's clock maps back through them", () =>
    Effect.gen(function* () {
      const a = yield* call(open, { src: A, offset: 2 })
      const b = yield* call(open, { src: B, offset: DELAY + 2 })
      const out = yield* call(compare, { a: a.handle, b: b.handle, at: ["0f", `${b.handle}@30f`] })
      expect(out.offsets).toEqual({ a: 2, b: DELAY + 2 })
      expect(out.frames.map((f) => f.index)).toEqual([0, 30 - DELAY])
      expect(out.bFrames.map((f) => f.index)).toEqual([DELAY, 30])
      expect(out.summary.changed).toBe(0)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("an address shifted past B's end fails, naming the offset and the moments both have", () =>
    Effect.gen(function* () {
      const a = yield* call(open, { src: A })
      const b = yield* call(open, { src: B, offset: DELAY })
      const error = yield* failure(compare, { a: a.handle, b: b.handle, at: ["-1f"] })
      expect(error).toMatchObject({
        _tag: "AddressOutOfRange",
        message: `-1f is 01s29f on ${a.handle} with ${b.handle}'s offset of +6f, which would be ${b.handle}'s frame #65, but ${b.handle} has frames #0 to #59.`,
        hint: `Use a moment both sources have: 0f..01s23f on ${a.handle} with ${b.handle}'s offset of +6f.`
      })
    }).pipe(Effect.provide(fresh))
  )

  it.effect("probe and a later open show the stored offset", () =>
    Effect.gen(function* () {
      const b = yield* call(open, { src: B, offset: -3 })
      expect((yield* call(probe, { source: b.handle })).offset).toBe(-3)
      expect((yield* call(open, { src: B })).offset).toBe(-3)
    }).pipe(Effect.provide(fresh))
  )
})
