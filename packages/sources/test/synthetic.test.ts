import { assert, describe, it } from "@effect/vitest"
import { Address, resolveContext } from "@kymo/core"
import { Effect, Layer } from "effect"
import { Sources, SyntheticAdapter } from "../src/index.ts"
import { centroid, read } from "./helpers.ts"

const SyntheticOnly = Sources.layerFrom(SyntheticAdapter).pipe(Layer.provide(SyntheticAdapter.layer))

const open = (spec: string) =>
  Effect.gen(function* () {
    const sources = yield* Sources
    return yield* sources.open(spec, "s")
  }).pipe(Effect.scoped, Effect.provide(SyntheticOnly))

const markers = (spec: string) =>
  Effect.map(open(spec), (s) =>
    s.timeline.markers.map((m): [string, number, string] => [m.name, m.index, m.origin])
  )

describe("synthetic sources", () => {
  it.effect("bounce: impact markers land on the requested frames and the timeline matches the spec", () =>
    Effect.gen(function* () {
      const source = yield* open(
        "synthetic:bounce?fps=30&frames=90&size=320x180&impact=20&period=16&bounces=3"
      )
      const t = source.timeline
      assert.deepStrictEqual(
        [t.kind, t.frameCount, t.rate, t.size, t.vfr],
        ["synthetic", 90, { num: 30, den: 1 }, { width: 320, height: 180 }, false]
      )
      assert.strictEqual(t.duration, "03s")
      // impacts: 20, then flights of 16 and round(16 * 0.6) = 10 frames
      assert.deepStrictEqual(
        t.markers.map((m) => [m.name, m.index, m.address, m.origin]),
        [
          ["impact1", 20, "20f", "truth"],
          ["impact2", 36, "01s06f", "truth"],
          ["impact3", 46, "01s16f", "truth"]
        ]
      )
      const resolved = yield* Address.resolveText(resolveContext(t), "@impact2+2f")
      assert.deepStrictEqual<ReadonlyArray<number>>(resolved, [38])
    })
  )

  it.effect("bounce: the ball's rendered centroid matches the box tracks", () =>
    Effect.gen(function* () {
      const source = yield* open("synthetic:bounce?frames=60&size=320x180&impact=20&bounces=2")
      const x = (yield* source.track("box.x")).samples
      const y = (yield* source.track("box.y")).samples
      const w = (yield* source.track("box.w")).samples
      const indices = [0, 10, 19, 20, 25, 33, 59]
      const frames = yield* read(source, indices)
      for (const frame of frames) {
        // The ball is the only bright-blue thing; the wall is grey and the background dark.
        const c = centroid(frame, 2, 160)
        const i = frame.index
        assert.approximately(c.x, x[i]! + w[i]! / 2, 0.5, `x at #${i}`)
        assert.approximately(c.y, y[i]! + w[i]! / 2, 0.5, `y at #${i}`)
      }
      // The ball touches the wall at impact1 and is moving away right after.
      assert.isAbove(x[20]!, x[19]!)
      assert.isBelow(x[21]!, x[20]!)
    })
  )

  it.effect("every track has one sample per frame", () =>
    Effect.gen(function* () {
      for (const scene of ["ease", "bounce", "flicker", "safe-area", "cut?fade=4", "dropped"]) {
        const source = yield* open(`synthetic:${scene.includes("?") ? scene + "&" : scene + "?"}frames=48`)
        assert.isAbove(source.timeline.tracks.length, 4, scene)
        for (const info of source.timeline.tracks) {
          const track = yield* source.track(info.name)
          assert.strictEqual(track.samples.length, 48, `${scene} ${info.name}`)
          assert.isTrue(
            track.samples.every((v) => v !== null && Number.isFinite(v)),
            `${scene} ${info.name}`
          )
        }
      }
    })
  )

  it.effect("ground-truth markers for each scene land where requested", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* markers("synthetic:flicker?at=33"), [["flicker", 33, "truth"]])
      assert.deepStrictEqual(yield* markers("synthetic:safe-area?exit=40&margin=5"), [
        ["exit_safe", 40, "truth"]
      ])
      assert.deepStrictEqual(yield* markers("synthetic:cut?at=45&fade=6"), [["cut", 45, "truth"]])
      assert.deepStrictEqual(yield* markers("synthetic:dropped?dups=30,12,13"), [
        ["dup1", 12, "truth"],
        ["dup2", 13, "truth"],
        ["dup3", 30, "truth"]
      ])
      assert.deepStrictEqual(yield* markers("synthetic:ease?start=5&end=50&easing=cubic-bezier(0.2,0,0,1)"), [
        ["motion_start", 5, "truth"],
        ["motion_end", 50, "truth"]
      ])
    })
  )

  it.effect("safe-area: the box first crosses the safe line at exit_safe", () =>
    Effect.gen(function* () {
      const source = yield* open("synthetic:safe-area?size=400x200&exit=30&margin=10")
      const x = (yield* source.track("box.x")).samples
      const w = (yield* source.track("box.w")).samples
      const right = (i: number) => x[i]! + w[i]!
      assert.isAtMost(right(29), 360)
      assert.isAbove(right(30), 360)
    })
  )

  it.effect("flicker and dropped frames show up in the pixels", () =>
    Effect.gen(function* () {
      const flicker = yield* open("synthetic:flicker?at=10&gain=50&frames=20")
      const [a, b, c] = yield* read(flicker, [9, 10, 11])
      assert.deepStrictEqual(a!.image.data, c!.image.data)
      assert.strictEqual(b!.image.data[0]! - a!.image.data[0]!, 50)

      const dropped = yield* open("synthetic:dropped?dups=15&frames=30")
      const [d14, d15, d16] = yield* read(dropped, [14, 15, 16])
      assert.deepStrictEqual(d14!.image.data, d15!.image.data)
      assert.isFalse(Buffer.from(d15!.image.data).equals(d16!.image.data))
    })
  )

  it.effect("spring easing settles on its own and overshoots", () =>
    Effect.gen(function* () {
      const source = yield* open("synthetic:ease?easing=spring(170,12)&start=10&frames=120")
      const p = (yield* source.track("ease.progress")).samples as ReadonlyArray<number>
      assert.isAbove(Math.max(...p), 1)
      const end = source.timeline.markers.find((m) => m.name === "motion_end")!
      assert.isTrue(p.slice(end.index).every((v) => Math.abs(1 - v) < 0.001))
    })
  )

  it.effect("rendering is deterministic and frames come back in the requested order", () =>
    Effect.gen(function* () {
      const spec = "synthetic:ease?easing=ease-out&frames=40"
      const first = yield* Effect.flatMap(open(spec), (s) => read(s, [30, 5, 30]))
      const second = yield* Effect.flatMap(open(spec), (s) => read(s, [30, 5, 30]))
      assert.deepStrictEqual(
        first.map((f) => f.index),
        [30, 5, 30]
      )
      for (let i = 0; i < first.length; i++)
        assert.deepStrictEqual(first[i]!.image.data, second[i]!.image.data)
      assert.strictEqual(first[1]!.t, 5 / 30)
    })
  )

  it.effect("downscales to maxEdge", () =>
    Effect.gen(function* () {
      const source = yield* open("synthetic:bounce?size=640x360")
      const [frame] = yield* read(source, [0], { maxEdge: 160 })
      assert.deepStrictEqual([frame!.image.width, frame!.image.height], [160, 90])
    })
  )

  it.effect("bad specs fail with InvalidInput naming the problem", () =>
    Effect.gen(function* () {
      const fail = (spec: string) => Effect.flip(open(spec))
      const unknownScene = yield* fail("synthetic:boing")
      assert.strictEqual(unknownScene._tag, "InvalidInput")
      assert.include(unknownScene.message, "bounce")
      const typo = yield* fail("synthetic:bounce?framez=90")
      assert.include(typo.message, `"framez"`)
      assert.include(typo.hint, "frames")
      const badSize = yield* fail("synthetic:bounce?size=big")
      assert.include(badSize.message, "640x360")
      const badEasing = yield* fail("synthetic:ease?easing=bouncy")
      assert.include(badEasing.message, "cubic-bezier")
      const late = yield* fail("synthetic:bounce?frames=30&impact=25&bounces=3")
      assert.include(late.message, "past the clip")
    })
  )

  it.effect("unknown tracks fail with the list of tracks", () =>
    Effect.gen(function* () {
      const source = yield* open("synthetic:bounce")
      const error = yield* Effect.flip(source.track("ball.x"))
      assert.strictEqual(error._tag, "InvalidInput")
      assert.include(error.hint, "box.x")
    })
  )

  it.effect("a registry with only synthetic refuses other inputs with the supported list", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(open("clip.mp4"))
      assert.strictEqual(error._tag, "SourceNotFound")
      assert.include(error.hint, "synthetic:")
    })
  )
})
