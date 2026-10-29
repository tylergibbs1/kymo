/** frames view=diff against a reference frame, and diff numbers without images. */
import { afterAll, describe, expect, it } from "@effect/vitest"
import { frames } from "kymo"
import { Effect } from "effect"
import { join } from "node:path"
import { call, failure, ffmpeg, fresh, mediaDir, missingOptions } from "./harness.ts"

const media = mediaDir()
afterAll(media.remove)

/**
 * H.264 footage, 30 fps, 2 s: a 100x40 blue panel slides from x=40 to x=300, moving in frames
 * 10..29 (overlay's n is one ahead of the frame index), then rests there; the page has a line of its own.
 */
const sliding = () => {
  const path = join(media.dir, "slide.mp4")
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "color=c=0xeef1f5:s=480x270:r=30:d=2,drawbox=x=20:y=200:w=300:h=8:color=0xc9d0db:t=fill",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x2b59c3:s=100x40:r=30:d=2",
    "-filter_complex",
    "[0][1]overlay=x='40+260*min(max((n-10)/20\\,0)\\,1)':y=100",
    "-c:v",
    "libx264",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    path
  )
  return path
}
const clip = sliding()
const AT_REST = "300,100,100,40"

describe("frames view=diff against a reference frame", () => {
  it.effect("compares every frame with the last one, so the first frame that looks final shows", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, {
        source: clip,
        range: "20f..40f",
        view: "diff",
        against: "-1f",
        box: AT_REST
      })
      expect(out.diff!.against).toBe("01s29f")
      const differs = out.diff!.frames.filter((f) => f.changedFraction > 0).map((f) => f.index)
      // The panel arrives at frame 29; from then on its box looks like the last frame.
      expect(differs).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28])
      expect(out.sheets[0]!.label).toContain("diff against 01s29f #59")
      expect(out.sheets[0]!.path).toContain("against-01s29f")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("against 0f keeps 0f in a range from it, compared with itself", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, { source: clip, range: "0f..12f", view: "diff", against: "0f" })
      expect(out.diff!.frames.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
      expect(out.diff!.frames[0]!.changedFraction).toBe(0)
      expect(out.diff!.frames.at(-1)!.changedFraction).toBeGreaterThan(0)
      expect(out.note ?? "").not.toContain("no previous frame")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("without against, says each frame is compared with the one before", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, { source: clip, range: "20f..22f", view: "diff" })
      expect(out.diff!.against).toBeNull()
    }).pipe(Effect.provide(fresh))
  )

  it.effect("refuses against on any other view, and a range for against", () =>
    Effect.gen(function* () {
      const sheet = yield* failure(frames, { source: clip, at: ["0f"], against: "-1f" })
      expect(sheet.message).toContain("against")
      expect(missingOptions(frames, sheet.hint)).toEqual([])
      const ranged = yield* failure(frames, { source: clip, at: ["5f"], view: "diff", against: "0f..2f" })
      expect(ranged.message).toContain("one frame")
    }).pipe(Effect.provide(fresh))
  )
})

describe("frames diff numbers without images", () => {
  const long = "synthetic:ease?frames=150"

  it.effect("a diff over more frames than the image cap is refused with a hint to ask for numbers", () =>
    Effect.gen(function* () {
      const capped = yield* failure(frames, { source: long, range: "0f..-1f", view: "diff" })
      expect(capped._tag).toBe("FrameCapExceeded")
      expect(capped.hint).toContain("numbersOnly")
      expect(missingOptions(frames, capped.hint)).toEqual([])
    }).pipe(Effect.provide(fresh))
  )

  it.effect("numbersOnly measures every frame and draws no images", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, { source: long, range: "0f..-1f", view: "diff", numbersOnly: true })
      expect(out.sheets).toEqual([])
      expect(out.next).toBeNull()
      expect(out.diff!.frames.map((f) => f.index)).toEqual(Array.from({ length: 149 }, (_, k) => k + 1))
      const against = yield* call(frames, {
        source: long,
        range: "0f..-1f",
        view: "diff",
        against: "-1f",
        numbersOnly: true
      })
      expect(against.diff!.frames).toHaveLength(150)
      expect(against.diff!.frames.at(-1)!.changedFraction).toBe(0)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("numbersOnly is for view=diff, and is capped too", () =>
    Effect.gen(function* () {
      const sheet = yield* failure(frames, { source: long, at: ["0f"], numbersOnly: true })
      expect(missingOptions(frames, sheet.hint)).toEqual([])
      const huge = yield* failure(frames, {
        source: "synthetic:ease?frames=1500",
        range: "0f..-1f",
        view: "diff",
        numbersOnly: true
      })
      expect(huge._tag).toBe("FrameCapExceeded")
      expect(huge.message).toContain("1000")
    }).pipe(Effect.provide(fresh))
  )
})
