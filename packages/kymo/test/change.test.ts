/**
 * Change inside a box, opacity and still positions, on H.264 footage built by ffmpeg: UI-like clips
 * where whole-frame motion is the wrong signal (a spinner elsewhere, a page dimming behind).
 */
import { describe, expect, it } from "@effect/vitest"
import { check, frames, track } from "kymo"
import { Effect } from "effect"
import { join } from "node:path"
import { afterAll, beforeAll } from "vitest"
import { call, failure, ffmpeg, fresh, mediaDir } from "./harness.ts"

const FPS = 30
const PAGE = "color=c=0xeef1f5:s=640x360:r=30:d=2"
/** Grey text lines on the page, so the page has edges of its own. */
const LINES = [
  "drawbox=x=40:y=80:w=300:h=10:color=0xc9d0db:t=fill",
  "drawbox=x=40:y=110:w=240:h=10:color=0xc9d0db:t=fill",
  "drawbox=x=40:y=140:w=270:h=10:color=0xc9d0db:t=fill"
].join(",")
/** A blue panel with a white "label" stripe. */
const panel = (w: number, h: number) =>
  `color=c=0x2b59c3:s=${w}x${h}:r=30:d=2,drawbox=x=10:y=${Math.round(h / 3)}:w=${Math.round(w * 0.6)}:h=${Math.max(4, Math.round(h / 3))}:color=white:t=fill`

const media = mediaDir()
const clips: Record<string, string> = {}

/**
 * A 120x24 toast slides in from off the right edge to x=500 (ease-out, 0.5 s..1 s: frames 15..30),
 * while a black backdrop fades in to 40% over the whole page (0.2 s..0.6 s: frames 6..18) and a
 * spinner turns in the bottom-right corner the whole time.
 */
const toast = (crf: number) => {
  const out = join(media.dir, `toast-${crf}.mp4`)
  const x = "500+140*pow(1-min(max((t-0.5)/0.5\\,0)\\,1)\\,3)"
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    `${PAGE},${LINES}`,
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=40x40:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=640x360:r=30:d=2,format=rgba,colorchannelmixer=aa=0.4,fade=t=in:st=0.2:d=0.4:alpha=1",
    "-f",
    "lavfi",
    "-i",
    panel(120, 24),
    "-filter_complex",
    `[0][1]overlay=x=580:y=300[s];[s][2]overlay[d];[d][3]overlay=x='${x}':y=40:eval=frame,format=yuv420p`,
    "-c:v",
    "libx264",
    "-crf",
    String(crf),
    out
  )
  return out
}

/** A 100x60 panel at (270, 150): moving from x=`from` over `move` seconds, fading in over `fade`, both from 0.3 s. */
const panelClip = (name: string, o: { from: number; move: number; fade: number; crf: number }) => {
  const out = join(media.dir, `${name}.mp4`)
  const x = o.move === 0 ? "270" : `${o.from}+(270-${o.from})*min(max((t-0.3)/${o.move}\\,0)\\,1)`
  const fade = o.fade === 0 ? "" : `,format=rgba,fade=t=in:st=0.3:d=${o.fade}:alpha=1`
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    `${PAGE},${LINES}`,
    "-f",
    "lavfi",
    "-i",
    `${panel(100, 60)}${fade}`,
    "-filter_complex",
    `[0][1]overlay=x='${x}':y=150:eval=frame,format=yuv420p`,
    "-c:v",
    "libx264",
    "-crf",
    String(o.crf),
    out
  )
  return out
}

beforeAll(() => {
  clips["toast23"] = toast(23)
  clips["toast35"] = toast(35)
  clips["fade"] = panelClip("fade", { from: 270, move: 0, fade: 0.5, crf: 28 })
  clips["fadeAfterMove"] = panelClip("fade-after-move", { from: 170, move: 0.3, fade: 0.7, crf: 28 })
})
afterAll(() => media.remove())

const TOAST_BOX = "500,40,120,24"

describe("change inside a box", () => {
  it.effect.each([23, 35])(
    "times a toast sliding in under a dimming backdrop and beside a spinner (crf %i)",
    (crf) =>
      Effect.gen(function* () {
        const out = yield* call(track, {
          source: clips[`toast${crf}`],
          box: TOAST_BOX,
          props: ["change"],
          format: "detailed"
        })
        const change = out.change!
        // On screen in the box from frame 16 (x 614); within a pixel of x=500 from frame 27.
        expect(change.state).toBe("changes")
        expect(change.within).toEqual({ px: 1, opacity: 0.02 })
        expect(change.starts).not.toBeNull()
        const starts = out.tracks[0]!.samples!.find((s) => s.address === change.starts)!.index
        const settles = out.tracks[0]!.samples!.find((s) => s.address === change.settles)!.index
        expect(starts).toBeGreaterThanOrEqual(15)
        expect(starts).toBeLessThanOrEqual(17)
        expect(settles).toBeGreaterThanOrEqual(27)
        expect(settles).toBeLessThanOrEqual(30)
        // The backdrop dimmed the page around the box while it was empty: taken out, not counted.
        expect(change.discounted.length).toBeGreaterThan(0)
        expect(change.floor).toBeGreaterThanOrEqual(5)
      }).pipe(Effect.provide(fresh))
  )

  it.effect("refuses a within rule on a call that measures no change", () =>
    Effect.gen(function* () {
      const e = yield* failure(track, {
        source: clips["toast23"],
        box: TOAST_BOX,
        props: ["x"],
        withinPx: 2
      })
      expect(e._tag).toBe("InvalidInput")
      expect((e as { hint: string }).hint).toContain('props=["change"]')
    }).pipe(Effect.provide(fresh))
  )

  it.effect("asks for a box when change or whole-frame motion is asked of a source's own tracks", () =>
    Effect.gen(function* () {
      const e = yield* failure(track, { source: "synthetic:bounce?impact=20", props: ["motion"] })
      expect(e._tag).toBe("InvalidInput")
      expect((e as { hint: string }).hint).toContain("motion.energy")
      expect((e as { hint: string }).hint).toContain('props=["change"]')
    }).pipe(Effect.provide(fresh))
  )
})

describe("check on change inside a box", () => {
  it.effect("proves the box stops changing once the toast has landed, and not before", () =>
    Effect.gen(function* () {
      const out = yield* call(check, {
        source: clips["toast23"],
        box: TOAST_BOX,
        assert: ["box.change == 0 after #31", "box.change == 0 after #20"]
      })
      expect(out.assertions.map((a) => a.pass)).toEqual([true, false])
    }).pipe(Effect.provide(fresh))
  )
})

describe("frames diff numbers", () => {
  it.effect("measures each diff inside a box, so a spinner elsewhere is not change", () =>
    Effect.gen(function* () {
      const inBox = yield* call(frames, {
        source: clips["toast23"],
        range: "#8..#20",
        view: "diff",
        box: TOAST_BOX
      })
      const changed = (n: typeof inBox) =>
        n.diff!.frames.filter((f) => f.changedFraction > 0).map((f) => f.index)
      expect(changed(inBox)[0]).toBeGreaterThanOrEqual(15)
      const whole = yield* call(frames, { source: clips["toast23"], range: "#8..#20", view: "diff" })
      // The spinner turns in every frame: the whole frame always changed.
      expect(changed(whole)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
      expect(whole.sheets[0]!.label).toContain("black under")
    }).pipe(Effect.provide(fresh))
  )
})

describe("opacity", () => {
  it.effect("measures a fade in place, frame by frame, from the box at rest", () =>
    Effect.gen(function* () {
      const out = yield* call(track, {
        source: clips["fade"],
        box: "270,150,100,60",
        range: "-1f..0f",
        props: ["opacity", "change"],
        format: "detailed"
      })
      const opacity = out.tracks.find((t) => t.name === "box.opacity")!.samples!
      for (const s of opacity) {
        const truth = Math.min(1, Math.max(0, (s.index / FPS - 0.3) / 0.5))
        expect(Math.abs((s.value ?? 0) - truth), `opacity at #${s.index}`).toBeLessThanOrEqual(0.08)
      }
      const at = (a: string | null) => opacity.find((s) => s.address === a)!.index
      expect(Math.abs(at(out.change!.starts) - 10)).toBeLessThanOrEqual(1)
      expect(Math.abs(at(out.change!.settles) - 24)).toBeLessThanOrEqual(1)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("sees a fade go on after the movement stopped", () =>
    Effect.gen(function* () {
      const out = yield* call(track, {
        source: clips["fadeAfterMove"],
        box: "270,150,100,60",
        range: "-1f..0f",
        props: ["x", "opacity", "change"],
        format: "detailed"
      })
      const series = (name: string) => out.tracks.find((t) => t.name === name)!
      const x = series("box.x")
      // Movement ends at 0.6 s (frame 18); the fade at 1 s (frame 30).
      const end = x.samples!.at(-1)!.value!
      const moving = x.samples!.filter((s) => s.value !== null && Math.abs(s.value - end) > 0.5)
      expect(Math.max(...moving.map((s) => s.index))).toBeLessThanOrEqual(19)
      const opaque = series("box.opacity").samples!.find((s) => (s.value ?? 0) >= 0.97)!.index
      expect(opaque).toBeGreaterThanOrEqual(28)
      const settles = x.samples!.find((s) => s.address === out.change!.settles)!.index
      expect(settles).toBeGreaterThanOrEqual(28)
    }).pipe(Effect.provide(fresh))
  )
})
