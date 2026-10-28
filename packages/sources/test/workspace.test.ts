import { assert, describe, it } from "@effect/vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach } from "vitest"
import { Sources, SyntheticAdapter, Workspace } from "../src/index.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "kymo-ws-"))
  roots.push(root)
  return root
}

const workspaceAt = (root: string) =>
  Workspace.layerAt(root).pipe(
    Layer.provide(Sources.layerFrom(SyntheticAdapter).pipe(Layer.provide(SyntheticAdapter.layer)))
  )

describe("Workspace", () => {
  it.effect("register, list and resolve round-trip through .kymo/handles.json", () => {
    const root = tempRoot()
    return Effect.gen(function* () {
      const ws = yield* Workspace
      assert.strictEqual(yield* ws.register("synthetic:bounce"), "clip1")
      assert.strictEqual(yield* ws.register("synthetic:bounce"), "clip1")
      assert.strictEqual(yield* ws.register("synthetic:flicker", "page"), "page")
      assert.deepStrictEqual(yield* ws.resolve("clip1"), { handle: "clip1", input: "synthetic:bounce" })
      assert.deepStrictEqual(yield* ws.resolve("synthetic:cut"), { handle: "clip2", input: "synthetic:cut" })
      assert.deepStrictEqual(yield* ws.resolve("synthetic:flicker"), {
        handle: "page",
        input: "synthetic:flicker"
      })
      assert.isTrue(existsSync(join(root, ".kymo", "handles.json")))

      // A fresh service over the same directory sees the same handles.
      const reloaded = yield* Effect.provide(Workspace, workspaceAt(root))
      assert.deepStrictEqual(
        (yield* reloaded.list).map((e) => [e.handle, e.input, e.offset]),
        [
          ["clip1", "synthetic:bounce", 0],
          ["page", "synthetic:flicker", 0]
        ]
      )
    }).pipe(Effect.provide(workspaceAt(root)))
  })

  it.effect("an unknown handle names the open sources", () =>
    Effect.gen(function* () {
      const ws = yield* Workspace
      const empty = yield* Effect.flip(ws.resolve("clip2"))
      assert.strictEqual(empty.message, `No source "clip2". No sources are open yet.`)
      yield* ws.register("synthetic:bounce")
      yield* ws.register("synthetic:flicker", "page")
      const error = yield* Effect.flip(ws.resolve("clip2"))
      assert.strictEqual(error._tag, "SourceNotFound")
      assert.strictEqual(error.message, `No source "clip2". Open sources: clip1, page.`)
      const marker = yield* Effect.flip(ws.addMarker("nope", "hit", 3))
      assert.strictEqual(marker.message, `No source "nope". Open sources: clip1, page.`)
    }).pipe(Effect.provide(workspaceAt(tempRoot())))
  )

  it.effect("handles and marker names are validated", () =>
    Effect.gen(function* () {
      const ws = yield* Workspace
      const badHandle = yield* Effect.flip(ws.register("synthetic:bounce", "my clip"))
      assert.strictEqual(badHandle._tag, "InvalidInput")
      yield* ws.register("synthetic:bounce", "hero-shot")
      const badMarker = yield* Effect.flip(ws.addMarker("hero-shot", "big-hit", 3))
      assert.strictEqual(badMarker._tag, "InvalidInput")
      const badIndex = yield* Effect.flip(ws.addMarker("hero-shot", "hit", -1))
      assert.strictEqual(badIndex._tag, "InvalidInput")
    }).pipe(Effect.provide(workspaceAt(tempRoot())))
  )

  it.effect("open remembers new inputs and adds agent markers and offsets", () =>
    Effect.gen(function* () {
      const ws = yield* Workspace
      const first = yield* Effect.scoped(ws.open("synthetic:bounce?impact=20"))
      assert.strictEqual(first.timeline.handle, "clip1")
      yield* ws.addMarker("clip1", "hit", 12)
      yield* ws.addMarker("clip1", "hit", 14)
      yield* ws.addMarker("clip1", "impact1", 21)
      yield* ws.setOffset("clip1", -3)

      const again = yield* Effect.scoped(ws.open("clip1"))
      assert.deepStrictEqual(
        again.timeline.markers.map((m) => [m.name, m.index, m.address, m.origin]),
        [
          ["impact2", 36, "01s06f", "truth"],
          ["impact3", 46, "01s16f", "truth"],
          ["hit", 14, "14f", "agent"],
          ["impact1", 21, "21f", "agent"]
        ]
      )
      assert.deepStrictEqual(
        (yield* ws.list).map((e) => [e.handle, e.offset, e.markers.length]),
        [["clip1", -3, 2]]
      )
    }).pipe(Effect.provide(workspaceAt(tempRoot())))
  )

  it.effect("a bad input is not remembered", () =>
    Effect.gen(function* () {
      const ws = yield* Workspace
      const error = yield* Effect.flip(Effect.scoped(ws.open("synthetic:boing")))
      assert.strictEqual(error._tag, "InvalidInput")
      assert.deepStrictEqual(yield* ws.list, [])
    }).pipe(Effect.provide(workspaceAt(tempRoot())))
  )
})
