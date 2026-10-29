import { describe, expect, it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import {
  AssertionResult,
  CheckReport,
  Cuts,
  EasingFit,
  FrameRange,
  Motion,
  RegionTrack,
  check,
  detectCuts,
  fitEasing,
  motionEnergy,
  runAssertions,
  scan,
  trackRegion
} from "@kymo/analysis"
import { fakeSource, texturedSquare } from "./fake.ts"

const source = fakeSource({
  frames: 60,
  scene: (i) =>
    i < 30
      ? { background: [60, 60, 70], texture: 20, rects: texturedSquare(4 + i, 18, 12) }
      : { background: [190, 180, 150], texture: 30, rects: texturedSquare(4 + i - 30, 10, 12) }
})

/** Every result a shell emits must satisfy the Schema it publishes. */
const conforms = <S extends Schema.Top>(schema: S, value: unknown) => {
  expect(() => Schema.decodeUnknownSync(schema as never)(value)).not.toThrow()
  expect(Schema.toJsonSchemaDocument(schema)).toBeDefined()
}

describe("result schemas", () => {
  it.effect("every analysis result decodes with its published schema", () =>
    Effect.gen(function* () {
      const range = yield* FrameRange.whole(source.timeline)
      const s = yield* scan(source, range)
      const cuts = detectCuts(s)
      const motion = motionEnergy(s, cuts)
      const region = yield* trackRegion(source, range.clamp(0, 29), { x: 4, y: 18, w: 12, h: 12 })
      conforms(Cuts, cuts)
      conforms(Motion, motion)
      conforms(RegionTrack, region)
      conforms(EasingFit, Result.getOrThrow(fitEasing(region.x, range.clamp(0, 29), { labelStyle: "both" })))
      conforms(
        CheckReport,
        yield* check({ labelStyle: "both", source, range, regions: [region], tracks: [region.x] })
      )
      for (const r of yield* runAssertions({
        labelStyle: "both",
        source,
        assertions: ["motion < 1 after @cut1"],
        tracks: [motion.track],
        markers: cuts.cuts.map((c) => c.marker)
      })) {
        conforms(AssertionResult, r)
      }
    })
  )
})
