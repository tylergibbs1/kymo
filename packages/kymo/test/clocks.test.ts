/**
 * Every address, label, duration and `t` on a source is read from one clock, and compare matches
 * two sources by time when their clocks differ.
 */
import { describe, expect, it } from "@effect/vitest"
import { compare, frames, probe, scan } from "kymo"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"
import { afterAll, beforeAll } from "vitest"
import { call, droppedFramesClip, fresh, gifWithDelays, mediaDir, testClip } from "./harness.ts"

const media = mediaDir()
let vfr = ""
let gif = ""
let at24 = ""
let at60 = ""
let plain = ""
let marked = ""

/** A dark 1280x720 UI with a small light label that only `marked` shows, from frame 2 on. */
const uiFrames = async (dir: string, label: boolean) => {
  mkdirSync(dir)
  for (let i = 0; i < 6; i++) {
    const base = sharp({ create: { width: 1280, height: 720, channels: 3, background: "#202830" } })
    const withLabel =
      label && i >= 2
        ? base.composite([
            {
              input: {
                create: { width: 60, height: 20, channels: 3, background: "#e0e0e0" }
              },
              left: 600,
              top: 340
            }
          ])
        : base
    await withLabel.png().toFile(join(dir, `f${i}.png`))
  }
  return `${dir}/`
}

beforeAll(async () => {
  vfr = droppedFramesClip(join(media.dir, "vfr.mp4"))
  gif = await gifWithDelays(join(media.dir, "uneven.gif"), [800, 300, 1500, 1500, 2800])
  at24 = testClip(join(media.dir, "at24.mp4"), 24, 2)
  at60 = testClip(join(media.dir, "at60.mp4"), 60, 2)
  plain = await uiFrames(join(media.dir, "plain"), false)
  marked = await uiFrames(join(media.dir, "marked"), true)
}, 60_000)
afterAll(() => media.remove())

/** A variable clock's address is the frame's start time in seconds. */
const seconds = (address: string) => Number(address.replace(/s$/, ""))

describe("variable frame rate", () => {
  it.effect("duration, labels and addresses are the frames' own presentation times", () =>
    Effect.gen(function* () {
      const t = yield* call(probe, { source: vfr })
      expect(t.vfr).toBe(true)
      expect(t.frameCount).toBe(40)
      expect(seconds(t.duration)).toBeCloseTo(t.durationSeconds, 3)
      const all = yield* call(frames, { source: vfr, range: "0f..-1f", format: "detailed" })
      for (const f of all.frames) expect(seconds(f.address), f.address).toBeCloseTo(f.t!, 3)
      expect(all.frames[10]).toMatchObject({ address: "0.8s", index: 10, t: 0.8 })
      for (const sheet of all.sheets)
        for (const f of sheet.frames) expect(sheet.label).not.toContain(`${f.index}f`)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("seconds name the frame on screen at that time; frames count decoded frames", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, {
        source: vfr,
        at: ["0.8s", "1s", "10f", "-1f", "0.8s..1s:2f"],
        format: "detailed"
      })
      // 0.8s and 10f are both #10; 1s is #15; 0.8s..1s:2f is #10, #12, #14; -1f is the last frame.
      expect(out.frames.map((f) => [f.index, f.t])).toEqual([
        [10, 0.8],
        [12, 0.88],
        [14, 0.96],
        [15, 1],
        [39, 1.96]
      ])
    }).pipe(Effect.provide(fresh))
  )

  it.effect("scan and frames agree on every frame's address and t", () =>
    Effect.gen(function* () {
      const overview = yield* call(scan, { source: vfr, budget: 6, sample: "even", format: "detailed" })
      const looked = yield* call(frames, {
        source: vfr,
        at: overview.frames.map((f) => `#${f.index}`),
        format: "detailed"
      })
      expect(overview.frames).toEqual(looked.frames)
    }).pipe(Effect.provide(fresh))
  )
})

describe("animated GIF timing", () => {
  it.effect("t is each frame's start from its delays, and labels and duration agree with it", () =>
    Effect.gen(function* () {
      const t = yield* call(probe, { source: gif })
      expect(t).toMatchObject({ frameCount: 5, vfr: true, durationSeconds: 6.9, duration: "6.9s" })
      const out = yield* call(frames, { source: gif, range: "0f..-1f", format: "detailed" })
      expect(out.frames).toEqual([
        { address: "0s", index: 0, t: 0 },
        { address: "0.8s", index: 1, t: 0.8 },
        { address: "1.1s", index: 2, t: 1.1 },
        { address: "2.6s", index: 3, t: 2.6 },
        { address: "4.1s", index: 4, t: 4.1 }
      ])
      const overview = yield* call(scan, { source: gif, budget: 5, sample: "even", format: "detailed" })
      expect(overview.frames.map((f) => f.t)).toEqual(out.frames.map((f) => f.t))
    }).pipe(Effect.provide(fresh))
  )

  it.effect("a time names the frame on screen then", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, { source: gif, at: ["4.5s", "3s", "1.1s"] })
      expect(out.frames.map((f) => f.index)).toEqual([2, 3, 4])
    }).pipe(Effect.provide(fresh))
  )
})

describe("compare across clocks", () => {
  it.effect("matches frames by time and labels each side with its own address", () =>
    Effect.gen(function* () {
      const out = yield* call(compare, { a: at24, b: at60, at: ["1s"] })
      expect(out.frames).toEqual([{ address: "01s", index: 24 }])
      expect(out.bFrames).toEqual([{ address: "01s", index: 60 }])
      expect(out.changes[0]).toMatchObject({ index: 24, bIndex: 60, bAddress: "01s" })
      expect(out.changes[0]!.meanDiff).toBeLessThan(0.02)
      expect(out.warnings?.[0]).toContain("matched by time")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("an address prefixed with B's handle is read on B's clock", () =>
    Effect.gen(function* () {
      const b = yield* call(probe, { source: at60 })
      const out = yield* call(compare, { a: at24, b: at60, at: [`${b.handle}@30f`, "#6"] })
      expect(out.frames.map((f) => f.index)).toEqual([6, 12])
      expect(out.bFrames.map((f) => f.index)).toEqual([15, 30])
    }).pipe(Effect.provide(fresh))
  )

  it.effect("the same clock still pairs by index", () =>
    Effect.gen(function* () {
      const out = yield* call(compare, { a: at24, b: at24, at: ["0f", "-1f"] })
      expect(out.frames.map((f) => f.index)).toEqual(out.bFrames.map((f) => f.index))
      expect(out.warnings).toBeUndefined()
    }).pipe(Effect.provide(fresh))
  )

  it.effect("counts a small change in a big frame as changed, and warns when sizes differ", () =>
    Effect.gen(function* () {
      const out = yield* call(compare, { a: plain, b: marked, range: "0f..-1f" })
      expect(out.changes.map((c) => c.meanDiff < 0.01)).toEqual([true, true, true, true, true, true])
      expect(out.summary.changed).toBe(4)
      expect(out.changes[2]!.changedFraction).toBeGreaterThan(0.001)
      expect(out.changes[2]!.changedMean).toBeGreaterThan(0.5)
      const scaled = yield* call(compare, { a: at24, b: plain, at: ["0f"] })
      expect(scaled.warnings?.join(" ")).toContain("diffs scale")
      const reshaped = yield* call(compare, { a: at24, b: gif, at: ["0f"] })
      expect(reshaped.warnings?.join(" ")).toContain("different shapes")
    }).pipe(Effect.provide(fresh))
  )
})
