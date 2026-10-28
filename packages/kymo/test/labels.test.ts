/** What sheet labels, notes and errors say: they must never contradict the frames they describe. */
import { describe, expect, it } from "@effect/vitest"
import { frames, probe } from "kymo"
import { Effect } from "effect"
import { join } from "node:path"
import { afterAll, beforeAll } from "vitest"
import { call, failure, ffmpeg, fresh, mediaDir } from "./harness.ts"

const BOUNCE = "synthetic:bounce?impact=20"
const media = mediaDir()
let theora = ""

beforeAll(() => {
  theora = join(media.dir, "clip.ogg")
  // This ffmpeg has no Theora encoder; VP8 in Ogg exercises the same container and extension.
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=25:duration=1",
    "-c:v",
    "libvpx",
    "-f",
    "ogg",
    theora
  )
}, 30_000)
afterAll(() => media.remove())

describe("sheet labels", () => {
  it.effect("two frames are some distance apart, not 'every' that distance", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, { source: BOUNCE, at: ["0f", "-1f"] })
      expect(out.sheets[0]!.label).toBe("Sheet 1 of 1 · clip1 · 0f–02s29f · 2 frames, 02s29f apart")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("gaps within a frame of each other are about even, not uneven", () =>
    Effect.gen(function* () {
      const even = yield* call(frames, { source: BOUNCE, at: ["#0", "#3", "#7", "#10", "#13"] })
      expect(even.sheets[0]!.label).toContain("5 frames, about every 3f")
      const uneven = yield* call(frames, { source: BOUNCE, at: ["#0", "#3", "#30"] })
      expect(uneven.sheets[0]!.label).toContain("3 frames, uneven spacing")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("separate images are numbered across cursors", () =>
    Effect.gen(function* () {
      const first = yield* call(frames, { source: BOUNCE, range: "0f..9f", separate: true })
      expect(first.sheets.map((s) => s.label.split(" · ")[0])).toEqual([
        "Frame 1 of 10",
        "Frame 2 of 10",
        "Frame 3 of 10",
        "Frame 4 of 10"
      ])
      const second = yield* call(frames, {
        source: BOUNCE,
        range: "0f..9f",
        separate: true,
        cursor: first.next
      })
      expect(second.sheets[0]!.label).toMatch(/^Frame 5 of 10 · /)
    }).pipe(Effect.provide(fresh))
  )
})

describe("view=diff", () => {
  it.effect("a range from 0f skips the first frame, which has nothing before it, and says so", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, { source: BOUNCE, range: "0f..3f", view: "diff" })
      expect(out.sheets[0]!.frames.map((f) => f.index)).toEqual([1, 2, 3])
      expect(out.note).toContain("0f has no previous frame")
    }).pipe(Effect.provide(fresh))
  )
})

describe("input errors", () => {
  it.effect("a bad view names view and lists the views, and blames nothing else", () =>
    Effect.gen(function* () {
      for (const shape of [{ at: ["0f"] }, { range: "0f..1s" }, {}]) {
        const e = yield* failure(frames, { source: BOUNCE, view: "bogus", ...shape })
        expect(e.message).toBe(
          'Invalid frames input: view: expected "sheet" | "onion" | "diff" | "follow" | "grid".'
        )
      }
    }).pipe(Effect.provide(fresh))
  )

  it.effect("a zero step is an address error, not a silent step of one", () =>
    Effect.gen(function* () {
      const e = yield* failure(frames, { source: BOUNCE, range: "1s..2s:0f" })
      expect(e._tag).toBe("AddressParseError")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("past the end names the last frame instead of a length that reads like one", () =>
    Effect.gen(function* () {
      const e = yield* failure(frames, { source: BOUNCE, at: ["03s"] })
      expect(e.message).toBe(
        "03s is past the end of clip1; the last frame is 02s29f (#89), also written -1f."
      )
    }).pipe(Effect.provide(fresh))
  )

  it.effect("the frame-cap hint only suggests what frames accepts", () =>
    Effect.gen(function* () {
      const e = yield* failure(frames, { source: "synthetic:bounce?frames=150", at: ["0f..-1f"] })
      expect(e._tag).toBe("FrameCapExceeded")
      expect(e.hint).not.toContain("sample=")
      expect(e.hint).toContain(":2f")
    }).pipe(Effect.provide(fresh))
  )
})

describe("containers", () => {
  it.effect("opens an Ogg file like any other video", () =>
    Effect.gen(function* () {
      const t = yield* call(probe, { source: theora })
      expect(t).toMatchObject({ kind: "video", frameCount: 25, fps: 25 })
    }).pipe(Effect.provide(fresh))
  )
})
