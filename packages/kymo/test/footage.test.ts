import { describe, expect, it } from "@effect/vitest"
import { type Operation, check, execute, kymoLayer, scan } from "kymo"
import { Effect, Layer, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll } from "vitest"
import { type Footage, dissolve, footage } from "./footage.ts"

const fresh = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "kymo-ops-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
    ),
    (dir) => kymoLayer({ root: dir, out: join(dir, "out") })
  )
)

type Codec = Schema.Codec<unknown, unknown, never, never>
const call = <I extends Codec, O extends Codec>(op: Operation<I, O>, input: unknown) =>
  Effect.flatMap(execute(op, input), (json) => Schema.decodeUnknownEffect(op.output)(json))

let clips: Footage
beforeAll(() => {
  clips = footage()
})
afterAll(() => clips.dispose())

const timing = (source: string) =>
  call(check, { source, rules: ["duplicate-frames", "dropped-frames"] }).pipe(
    Effect.map((out) =>
      out.findings.map((f) => ({ rule: f.rule, severity: f.severity, index: f.index, message: f.message }))
    )
  )

const cutsOf = (source: string) =>
  call(scan, { source, budget: 4 }).pipe(Effect.map((out) => out.cuts.map((c) => c.kind)))

describe("cuts in encoded footage", () => {
  it.effect("finds a one-second cross-dissolve as one fade", () =>
    Effect.gen(function* () {
      const source = dissolve(clips, "dissolve-24", { fps: 24, offset: 2, seconds: 1 })
      expect(yield* cutsOf(source)).toEqual(["fade"])
    }).pipe(Effect.provide(fresh))
  )

  it.effect("finds the dissolve as one fade at 60 fps too, not a run of hard cuts", () =>
    Effect.gen(function* () {
      const source = dissolve(clips, "dissolve-60", { fps: 24, offset: 2, seconds: 1, then: ["fps=60"] })
      expect(yield* cutsOf(source)).toEqual(["fade"])
    }).pipe(Effect.provide(fresh))
  )
})

describe("frame timing on encoded footage", () => {
  it.effect(
    "finds a dropped frame in a textured pan, where the skip moves the picture only ~1.6x a step",
    () =>
      Effect.gen(function* () {
        const source = clips.clip("pan-drop", { frames: 80, fps: 24, speed: 6, travel: "n+gte(n,40)" })
        const found = yield* timing(source)
        expect(found.map((f) => [f.rule, f.index])).toEqual([["dropped-frames", 40]])
      }).pipe(Effect.provide(fresh))
  )

  it.effect("summarises a 25 to 24 fps conversion as one cadence of skipped frames", () =>
    Effect.gen(function* () {
      const source = clips.clip("pal-to-film", { frames: 168, fps: 25, speed: 4, then: ["fps=24"] })
      const found = yield* timing(source)
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ rule: "dropped-frames", severity: "warning" })
      expect(found[0]!.message).toContain("from 25 fps to 24 fps")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("finds a held frame right after a fade-in", () =>
    Effect.gen(function* () {
      const source = clips.clip("fade-hold", {
        frames: 60,
        fps: 24,
        speed: 6,
        travel: "n-eq(n,21)",
        then: ["fade=t=in:s=0:n=20"]
      })
      const found = yield* timing(source)
      expect(found.map((f) => [f.rule, f.index])).toEqual([["duplicate-frames", 21]])
    }).pipe(Effect.provide(fresh))
  )

  it.effect("sees held frames through heavy encoder noise", () =>
    Effect.gen(function* () {
      // Animation on twos (every odd frame holds the even one), at a quality where a held frame is not
      // bit-identical to the one before.
      const source = clips.clip("twos-noisy", {
        frames: 72,
        fps: 24,
        speed: 3,
        travel: "n-mod(n,2)",
        crf: 42
      })
      const found = yield* timing(source)
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ rule: "duplicate-frames", severity: "info" })
      expect(found[0]!.message).toContain("held on twos")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("a cross-dissolve is a transition, not a dropped frame", () =>
    Effect.gen(function* () {
      const source = dissolve(clips, "dissolve-check", { fps: 24, offset: 2, seconds: 1 })
      const found = yield* timing(source)
      expect(found.filter((f) => f.rule === "dropped-frames")).toEqual([])
    }).pipe(Effect.provide(fresh))
  )

  it.effect("summarises 24 fps pulled down to 60 as one info finding, not a warning per repeat", () =>
    Effect.gen(function* () {
      const source = clips.clip("pulldown", { frames: 180, fps: 24, speed: 4, then: ["fps=60"] })
      const found = yield* timing(source)
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ rule: "duplicate-frames", severity: "info" })
      expect(found[0]!.message).toContain("3 of every 5 frames")
      expect(found[0]!.message).toContain("from 24 fps to 60 fps")
    }).pipe(Effect.provide(fresh))
  )
})
