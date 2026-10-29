import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { FrameRange, detectCuts, scan } from "@kymo/analysis"
import { type Rgb, type Scene, fakeSource } from "./fake.ts"

/** A dark chat page: a faint line of text streams in every five frames. */
const chat = (i: number): Scene => ({
  background: [26, 26, 26],
  rects: Array.from({ length: Math.min(3, 1 + Math.floor(i / 5)) }, (_, r) => ({
    x: 6,
    y: 6 + 4 * r,
    w: 24 + 3 * r,
    h: 1,
    rgb: [70, 70, 70] as const
  }))
})
/** A title card a shade darker, with one short line of white text: barely different on average. */
const title: Scene = {
  background: [22, 22, 22],
  rects: [{ x: 22, y: 24, w: 20, h: 1, rgb: [220, 220, 220] }]
}

describe("cuts in a screen recording", () => {
  it.effect("finds a title card in a dark UI, though it moves the frame's mean little", () =>
    Effect.gen(function* () {
      const source = fakeSource({ frames: 60, scene: (i) => (i < 40 ? chat(i) : title) })
      const range = yield* FrameRange.whole(source.timeline)
      const s = yield* scan(source, range)
      expect(s.frames[40]!.motion!).toBeLessThan(0.03)
      expect(detectCuts(s).cuts.map((c) => [c.kind, c.marker.index])).toEqual([["hard", 40]])
    })
  )

  it.effect("finds every cut of a slideshow, where nothing moves but the cuts", () =>
    Effect.gen(function* () {
      const slide = (n: number): Scene => ({
        background: [40 + 50 * (n % 4), 60, 200 - 40 * (n % 4)],
        rects: [{ x: 8 + 9 * n, y: 10, w: 12, h: 20, rgb: [250, 250, 250] }]
      })
      const source = fakeSource({ frames: 60, scene: (i) => slide(Math.floor(i / 10)) })
      const range = yield* FrameRange.whole(source.timeline)
      const s = yield* scan(source, range)
      expect(detectCuts(s).cuts.map((c) => c.marker.index)).toEqual([10, 20, 30, 40, 50])
    })
  )
})

/** A light dashboard: a dark header and a few lines of text. */
const lightPage: Scene = {
  background: [238, 241, 245],
  rects: [
    { x: 0, y: 0, w: 64, h: 4, rgb: [20, 30, 50] },
    { x: 3, y: 8, w: 25, h: 1, rgb: [190, 196, 208] },
    { x: 3, y: 11, w: 18, h: 1, rgb: [190, 196, 208] },
    { x: 35, y: 8, w: 26, h: 1, rgb: [190, 196, 208] },
    { x: 3, y: 40, w: 58, h: 1, rgb: [190, 196, 208] },
    { x: 3, y: 43, w: 44, h: 1, rgb: [190, 196, 208] }
  ]
}
/** The page navigated to: a header and four cards, on a dark or a light theme. */
const settings = (dark: boolean): Scene => {
  const card: Rgb = dark ? [44, 52, 70] : [227, 217, 196]
  return {
    background: dark ? [27, 31, 42] : [247, 243, 234],
    rects: [
      { x: 0, y: 0, w: 64, h: 4, rgb: dark ? [13, 18, 32] : [107, 79, 42] },
      { x: 2, y: 6, w: 19, h: 11, rgb: card },
      { x: 23, y: 6, w: 19, h: 11, rgb: card },
      { x: 44, y: 6, w: 18, h: 11, rgb: card },
      { x: 2, y: 19, w: 60, h: 27, rgb: card }
    ]
  }
}
const white: Scene = { background: [255, 255, 255] }
const black: Scene = { background: [0, 0, 0] }
/** `to` cross-fading over `from` at opacity `alpha`. */
const mixed = (from: Scene, to: Scene, alpha: number): Scene =>
  alpha <= 0 ? from : { ...from, over: { scene: to, alpha: Math.min(1, alpha) } }
/** 0 up to frame `a`, 1 from frame `b`, linear between. */
const ramp = (i: number, a: number, b: number) => Math.max(0, Math.min(1, (i - a) / (b - a)))
/** The light page with more layers drawn over it. */
const withLayers = (layers: NonNullable<Scene["rects"]>): Scene => ({
  ...lightPage,
  rects: [...lightPage.rects!, ...layers]
})

const cutsIn = (scene: (i: number) => Scene, frames = 120) =>
  Effect.gen(function* () {
    const source = fakeSource({ frames, fps: 60, scene })
    const range = yield* FrameRange.whole(source.timeline)
    return detectCuts(yield* scan(source, range)).cuts
  })

describe("page transitions in a UI recording", () => {
  it.effect("a one-frame white flash before a dissolve is neither a cut nor part of the fade", () =>
    Effect.gen(function* () {
      // The dissolve starts at frame 72 and is 1/9 mixed at 73; the page flashes white at frame 60.
      const cuts = yield* cutsIn((i) =>
        i === 60 ? white : mixed(lightPage, settings(true), ramp(i, 72, 81))
      )
      expect(cuts.map((c) => [c.kind, c.from.index, c.incoming.index])).toEqual([["fade", 72, 73]])
    })
  )

  it.effect("a dissolve's incoming frame is the first one measurably mixed, though it eases in", () =>
    Effect.gen(function* () {
      // Ease-in from frame 48: 0.7% mixed at 50, 1.6% at 51, 4.3% at 53, 6.3% at 54.
      const cuts = yield* cutsIn((i) => mixed(lightPage, settings(true), ramp(i, 48, 72) ** 2))
      expect(cuts.map((c) => [c.kind, c.incoming.index])).toEqual([["fade", 51]])
    })
  )

  it.effect("a dissolve between two light pages is a fade", () =>
    Effect.gen(function* () {
      const cuts = yield* cutsIn((i) => mixed(lightPage, settings(false), ramp(i, 30, 48)))
      expect(cuts.map((c) => [c.kind, c.incoming.index])).toEqual([["fade", 31]])
    })
  )

  it.effect("a backdrop dimming the unchanged page while a dialog fades in is not a cut", () =>
    Effect.gen(function* () {
      const cuts = yield* cutsIn(
        (i) =>
          withLayers([
            { x: 0, y: 0, w: 64, h: 48, rgb: [0, 0, 0], alpha: 0.35 * ramp(i, 18, 54) },
            { x: 20, y: 14, w: 24, h: 18, rgb: [255, 255, 255], alpha: ramp(i, 21, 45) }
          ]),
        60
      )
      expect(cuts).toEqual([])
    })
  )

  it.effect("a backdrop and dialog that appear at once over the unchanged page are not a cut", () =>
    Effect.gen(function* () {
      const dimmed = withLayers([
        { x: 0, y: 0, w: 64, h: 48, rgb: [0, 0, 0], alpha: 0.5 },
        { x: 20, y: 14, w: 24, h: 18, rgb: [255, 255, 255] }
      ])
      expect(yield* cutsIn((i) => (i < 30 ? lightPage : dimmed), 60)).toEqual([])
    })
  )

  it.effect("a dialog fading in over the page is not a cut", () =>
    Effect.gen(function* () {
      const cuts = yield* cutsIn(
        (i) => withLayers([{ x: 16, y: 12, w: 32, h: 20, rgb: [44, 52, 70], alpha: ramp(i, 13, 30) }]),
        60
      )
      expect(cuts).toEqual([])
    })
  )

  it.effect("a fade to black and back in from black are both fades", () =>
    Effect.gen(function* () {
      const cuts = yield* cutsIn((i) =>
        i < 50 ? mixed(lightPage, black, ramp(i, 30, 48)) : mixed(black, settings(false), ramp(i, 60, 78))
      )
      expect(cuts.map((c) => [c.kind, c.incoming.index])).toEqual([
        ["fade", 31],
        ["fade", 61]
      ])
    })
  )

  it.effect("a dip to black with no black held is one transition, as an editor calls it", () =>
    Effect.gen(function* () {
      const cuts = yield* cutsIn((i) =>
        i < 48 ? mixed(lightPage, black, ramp(i, 30, 48)) : mixed(black, settings(false), ramp(i, 48, 66))
      )
      expect(cuts.map((c) => c.kind)).toEqual(["fade"])
    })
  )
})

/** A small blue spinner turning near the middle, so the page is never still. */
const spinning = (scene: Scene, i: number): Scene => ({
  ...scene,
  rects: [
    ...(scene.rects ?? []),
    { x: 28 + 3 * Math.cos(i / 3), y: 20 + 3 * Math.sin(i / 3), w: 4, h: 4, rgb: [40, 80, 220] }
  ]
})

describe("flashes are not transitions", () => {
  it.effect("a white flash on a light page with a spinner is no cut, for one frame or a few", () =>
    Effect.gen(function* () {
      for (const flashed of [[60], [60, 61], [60, 61, 62]]) {
        const cuts = yield* cutsIn((i) => spinning(flashed.includes(i) ? white : lightPage, i))
        expect({ flashed, cuts }).toEqual({ flashed, cuts: [] })
      }
    })
  )

  it.effect("a flash inside or at either end of a dissolve leaves the dissolve's ends alone", () =>
    Effect.gen(function* () {
      // A flash on 81, the frame the fade completes, hides it: 82 is the first frame seen whole.
      for (const [at, to] of [
        [71, 81],
        [76, 81],
        [81, 82],
        [82, 81]
      ]) {
        const cuts = yield* cutsIn((i) =>
          spinning(i === at ? white : mixed(lightPage, settings(true), ramp(i, 72, 81)), i)
        )
        const found = cuts.map((c) => [c.kind, c.from.index, c.incoming.index, c.to.index])
        expect({ at, found }).toEqual({ at, found: [["fade", 72, 73, to]] })
      }
    })
  )

  it.effect("a hard cut next to a flash is one cut at the new picture", () =>
    Effect.gen(function* () {
      for (const at of [59, 60]) {
        const cuts = yield* cutsIn((i) => spinning(i === at ? white : i < 60 ? lightPage : settings(true), i))
        expect({ at, found: cuts.map((c) => [c.kind, c.incoming.index]) }).toEqual({
          at,
          found: [["hard", at === 59 ? 60 : 61]]
        })
      }
    })
  )
})
