import { afterAll, describe, expect, it } from "@effect/vitest"
import { check } from "kymo"
import { Effect } from "effect"
import { join } from "node:path"
import { call, failure, ffmpeg, fresh, mediaDir, missingOptions } from "./harness.ts"

const media = mediaDir()
afterAll(media.remove)

/**
 * Footage with no tracks of its own: a 20 px square runs right 6 px a frame from x=10, slips back
 * 6 px a frame over frames 20–22, then runs on.
 */
const slipping = () => {
  const path = join(media.dir, "slip.mp4")
  const x = "if(lt(n,20),10+6*n,if(lt(n,23),124-6*(n-20),118+6*(n-23)))"
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "color=c=white:s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=20x20:r=30:d=2",
    "-filter_complex",
    `[0][1]overlay=x='${x}':y=80`,
    "-pix_fmt",
    "yuv420p",
    path
  )
  return path
}
const clip = slipping()

describe("check non-monotonic on footage", () => {
  it.effect("checks a box's moving axis, so a slip back is found without naming tracks", () =>
    Effect.gen(function* () {
      const out = yield* call(check, { source: clip, box: "10,80,20,20", rules: ["non-monotonic"] })
      expect(out.findings.map((f) => [f.rule, f.index])).toEqual([["non-monotonic", 20]])
      expect(out.findings[0]!.message).toMatch(/^box\.x reverses/)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("checks only the tracks named, including a box's", () =>
    Effect.gen(function* () {
      const x = yield* call(check, { source: clip, box: "10,80,20,20", tracks: ["box.x"] })
      expect(x.rules).toContain("non-monotonic")
      expect(x.findings.filter((f) => f.rule === "non-monotonic").map((f) => f.index)).toEqual([20])
      const y = yield* call(check, {
        source: clip,
        box: "10,80,20,20",
        rules: ["non-monotonic"],
        tracks: ["box.y"]
      })
      expect(y.findings).toEqual([])
    }).pipe(Effect.provide(fresh))
  )
})

describe("check hints", () => {
  // Every way check can refuse an input; each hint must name only options that exist.
  const refused = [
    { source: clip, rules: ["non-monotonic"] },
    { source: clip, rules: ["safe-area"] },
    { source: clip, tracks: ["box.x"] },
    { source: clip, box: "10,80,20,20", tracks: ["box.q"] },
    { source: clip, box: "10,80,20,20", rules: ["flicker"], tracks: ["box.x"] },
    { source: clip, box: "10,80,20,20", assert: ["box.x <= 600"], tracks: ["box.x"] },
    { source: clip, assert: ["box.x <= 600"] },
    { source: clip, assert: ["box.x is big"] },
    { source: clip, box: "300,170,64,64" },
    { source: clip, box: "10,80" },
    { source: clip, range: "0f..9s" },
    { source: clip, rules: ["sparkle"] },
    { source: clip, trakcs: ["box.x"] },
    { source: "synthetic:flicker", tracks: ["flash.gian"] }
  ]

  it.effect("name only fields and flags that check (or the command they show) has", () =>
    Effect.gen(function* () {
      for (const input of refused) {
        const error = yield* failure(check, input)
        expect({ input, hint: error.hint, missing: missingOptions(check, error.hint) }).toMatchObject({
          missing: []
        })
      }
    }).pipe(Effect.provide(fresh))
  )

  it("catch an option that does not exist", () => {
    expect(missingOptions(check, "Name them, e.g. tracks=box.x,#hero.opacity.")).toEqual([])
    expect(missingOptions(check, "Pass sample=motion (CLI: --sample motion).")).toEqual([
      "--sample",
      "sample="
    ])
    expect(missingOptions(check, "find it with kymo frames clip1 --at 0f --views grid, then")).toEqual([
      "frames --views"
    ])
  })
})
