import { describe, expect, it } from "@effect/vitest"
import { type Operation, execute, kymoLayer, track } from "kymo"
import { Effect, Layer, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll } from "vitest"

const fresh = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "kymo-track-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
    ),
    (dir) => kymoLayer({ root: dir, out: join(dir, "out") })
  )
)

type Codec = Schema.Codec<unknown, unknown, never, never>
const call = <I extends Codec, O extends Codec>(op: Operation<I, O>, input: unknown) =>
  Effect.flatMap(execute(op, input), (json) => Schema.decodeUnknownEffect(op.output)(json))
const failure = (input: unknown) => Effect.flip(execute(track, input))

/** Clips like UI footage: a textured 80x60 panel on a light page, 320x180 at 30 fps for 2 s. */
let dir = ""
/** Fades in and slides right 100px (x 60 → 160) together over 0.4 s..0.9 s (frames 12..27). */
let fadeIn = ""
/** Holds at x 120 until 0.4 s, then slides right off the frame to x 360 by 1.0 s (frames 12..30). */
let exit = ""

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kymo-track-clips-"))
  const panel = (fade: string) => `testsrc2=s=80x60:r=30:d=2,format=rgba${fade}`
  const clip = (out: string, fade: string, x: string) =>
    execFileSync("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0xeef1f5:s=320x180:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      panel(fade),
      "-filter_complex",
      `[0][1]overlay=x='${x}':y=60:eval=frame:format=rgb,format=yuv420p`,
      "-g",
      "12",
      out
    ])
  fadeIn = join(dir, "fade-in.mp4")
  clip(fadeIn, ",fade=t=in:st=0.4:d=0.5:alpha=1", "60+100*min(max((t-0.4)/0.5\\,0)\\,1)")
  exit = join(dir, "exit.mp4")
  clip(exit, "", "120+240*min(max((t-0.4)/0.6\\,0)\\,1)")
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const values = (out: {
  readonly tracks: ReadonlyArray<{ readonly samples?: ReadonlyArray<{ readonly value: number | null }> }>
}) => out.tracks[0]!.samples!.map((s) => s.value)

describe("track anchors the box where the subject is fully visible", () => {
  it.effect("a range written backwards tracks back from its first address and fits the whole fade-in", () =>
    Effect.gen(function* () {
      const out = yield* call(track, {
        source: fadeIn,
        box: "160,60,80,60",
        range: "1s..0f",
        props: ["x"],
        fitEasing: true,
        format: "detailed"
      })
      expect(out.range).toBe("0f..01s")
      expect(out.anchor).toBe("01s")
      const xs = values(out)
      // Visible from frame 13 (alpha 0.07): every frame from there is where the overlay put it (on
      // whole pixels, so within 1.5px of the formula).
      for (let i = 13; i <= 30; i++) {
        const truth = 60 + 100 * Math.min(Math.max((i / 30 - 0.4) / 0.5, 0), 1)
        expect(Math.abs(xs[i]! - truth), `frame ${i}`).toBeLessThanOrEqual(1.5)
      }
      expect(out.lost).toEqual([{ range: "0f..12f", frames: 13, reason: "faded" }])
      const [fit] = out.easing
      expect(fit).toMatchObject({ start: "appeared", end: "rest", from: { index: 12 }, to: { index: 27 } })
      expect(fit!.best.family).toBe("linear")
      expect(Math.abs(fit!.startValue - 60)).toBeLessThan(3)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("anchor names the box's frame inside a forward range", () =>
    Effect.gen(function* () {
      const out = yield* call(track, {
        source: fadeIn,
        box: "160,60,80,60",
        range: "0f..1s",
        anchor: "1s",
        props: ["x"],
        format: "detailed"
      })
      expect(out.anchor).toBe("01s")
      expect(values(out)[20]).not.toBeNull()
    }).pipe(Effect.provide(fresh))
  )

  it.effect("rejects an anchor outside the range, or without a box", () =>
    Effect.gen(function* () {
      const outside = yield* failure({ source: fadeIn, box: "160,60,80,60", range: "0f..10f", anchor: "1s" })
      expect(outside._tag).toBe("InvalidInput")
      expect(outside.hint).toContain("anchor=10f")
      const boxless = yield* failure({ source: "synthetic:ease", anchor: "1s" })
      expect(boxless._tag).toBe("InvalidInput")
    }).pipe(Effect.provide(fresh))
  )
})

describe("track follows a subject out of the frame", () => {
  it.effect(
    "reports positions past the edge, then lost at the edge; a linear exit's end is not determined",
    () =>
      Effect.gen(function* () {
        const out = yield* call(track, {
          source: exit,
          box: "120,60,80,60",
          props: ["x"],
          fitEasing: true,
          format: "detailed"
        })
        const xs = values(out)
        const truth = (i: number) => 120 + 240 * Math.min(Math.max((i / 30 - 0.4) / 0.6, 0), 1)
        // Half the panel still in the 320px frame: x + 40 <= 320.
        const half = xs.map((_, i) => i).filter((i) => truth(i) + 40 <= 320)
        expect(half.some((i) => truth(i) + 80 > 320)).toBe(true)
        for (const i of half) expect(Math.abs(xs[i]! - truth(i)), `frame ${i}`).toBeLessThanOrEqual(1.5)
        expect(out.lost.every((l) => l.reason === "edge")).toBe(true)
        // Moving at a constant speed when it left, it could have stopped at any later frame.
        expect(out.easing).toEqual([])
        expect(out.easingSkipped).toMatchObject([{ track: "box.x", status: "partial" }])
        expect(out.easingSkipped![0]!.reason).toContain("the end of the motion is not determined")
      }).pipe(Effect.provide(fresh))
  )
})

describe("track says why a track has no easing fit", () => {
  it.effect("a box lost in every frame is lost, not still", () =>
    Effect.gen(function* () {
      const out = yield* call(track, {
        source: "synthetic:bounce?impact=20",
        box: "64,137,43,43",
        range: "#25..#45",
        fitEasing: true
      })
      expect(out.easing).toEqual([])
      expect(out.easingSkipped!.map((u) => u.status)).toEqual(["lost", "lost"])
      expect(out.note).not.toContain("does not change")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("a still axis is no motion, with its travel", () =>
    Effect.gen(function* () {
      const out = yield* call(track, { source: exit, box: "120,60,80,60", props: ["y"], fitEasing: true })
      expect(out.easingSkipped).toMatchObject([{ track: "box.y", status: "no-motion" }])
      expect(out.note).toContain("under the 2 px that counts as motion")
    }).pipe(Effect.provide(fresh))
  )
})
