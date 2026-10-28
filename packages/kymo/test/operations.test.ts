import { describe, expect, it } from "@effect/vitest"
import {
  type AnyOperation,
  type Operation,
  check,
  compare,
  decodeInput,
  execute,
  flatInputSchema,
  frames,
  jsonSchema,
  kymoLayer,
  operations,
  probe,
  record,
  scan,
  track
} from "kymo"
import { Effect, Layer, Schema } from "effect"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

/** A fresh workspace root and image directory per test, removed afterwards. */
const fresh = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "kymo-ops-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
    ),
    (dir) => kymoLayer({ root: dir, out: join(dir, "out") })
  )
)

const BOUNCE = "synthetic:bounce?impact=20"

type Codec = Schema.Codec<unknown, unknown, never, never>

/** Run an operation the way every shell does: raw JSON in; the JSON is then decoded with the output Schema. */
const call = <I extends Codec, O extends Codec>(op: Operation<I, O>, input: unknown) =>
  Effect.flatMap(execute(op, input), (json) => Schema.decodeUnknownEffect(op.output)(json))

const failure = (op: AnyOperation, input: unknown) => Effect.flip(execute(op, input))

describe("operation contracts", () => {
  it.effect("every example decodes with its operation's input Schema", () =>
    Effect.gen(function* () {
      const all: ReadonlyArray<AnyOperation> = operations
      for (const op of all)
        for (const example of op.examples) yield* decodeInput(op, example).pipe(Effect.orDie)
    })
  )

  it("every input flattens to one object schema and every output is an object schema", () => {
    for (const op of operations) {
      expect(flatInputSchema(op).type).toBe("object")
      expect(jsonSchema(op.output)["type"]).toBe("object")
    }
  })

  it.effect("unknown fields and mixing at with range are input errors that say what is wrong", () =>
    Effect.gen(function* () {
      const typo = yield* failure(frames, { source: BOUNCE, at: ["0f"], veiw: "diff" })
      expect(typo._tag).toBe("InvalidInput")
      expect(typo.message).toContain("veiw: is not a field")
      const both = yield* failure(frames, { source: BOUNCE, at: ["0f"], range: "1s..2s" })
      expect(both._tag).toBe("InvalidInput")
      expect(both.message).toContain("range: is not a field")
      expect(both.hint).toContain("kymo schema frames")
    }).pipe(Effect.provide(fresh))
  )
})

describe("probe", () => {
  it.effect("returns the Timeline under a reusable handle", () =>
    Effect.gen(function* () {
      const t = yield* call(probe, { source: BOUNCE })
      expect(t).toMatchObject({ handle: "clip1", frameCount: 90, fps: 30, duration: "03s" })
      expect(t.markers.map((m) => m.name)).toEqual(["impact1", "impact2", "impact3"])
      const again = yield* call(probe, { source: "clip1" })
      expect(again.input).toBe(BOUNCE)
    }).pipe(Effect.provide(fresh))
  )
})

describe("frames", () => {
  it.effect("labels each sheet with its position, source, span and spacing", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, { source: BOUNCE, range: "0f..01s:5f" })
      expect(out.frames.map((f) => f.address)).toEqual(["0f", "5f", "10f", "15f", "20f", "25f", "01s"])
      expect(out.sheets).toHaveLength(1)
      const sheet = out.sheets[0]!
      expect(sheet.label).toBe("Sheet 1 of 1 · clip1 · 0f–01s · 7 frames, every 5f")
      expect(basename(sheet.path)).toBe("0f-01s.png")
      expect(existsSync(sheet.path)).toBe(true)
      expect(sheet.width).toBeUndefined()
      expect(out.next).toBeNull()
    }).pipe(Effect.provide(fresh))
  )

  it.effect("detailed adds times, sizes, markers and track values", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, { source: BOUNCE, at: ["@impact1"], format: "detailed" })
      expect(out.frames).toEqual([{ address: "20f", index: 20, t: 20 / 30 }])
      expect(out.sheets[0]).toMatchObject({ frames: [{ address: "20f", index: 20, t: 20 / 30 }] })
      expect(out.sheets[0]!.tokens).toBeGreaterThan(0)
      expect(out.markers?.map((m) => m.name)).toEqual(["impact1"])
      expect(Object.keys(out.samples?.[0]?.values ?? {})).toContain("box.x")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("separate writes one image per frame named by its address", () =>
    Effect.gen(function* () {
      const out = yield* call(frames, { source: BOUNCE, at: ["0f", "1s", "-1f"], separate: true })
      expect(out.sheets.map((s) => basename(s.path))).toEqual(["0f.png", "01s.png", "02s29f.png"])
      expect(out.sheets.map((s) => s.label)).toEqual([
        "Frame 1 of 3 · clip1 · 0f #0",
        "Frame 2 of 3 · clip1 · 01s #30",
        "Frame 3 of 3 · clip1 · 02s29f #89"
      ])
    }).pipe(Effect.provide(fresh))
  )

  it.effect("pages beyond four sheets with a cursor and a note", () =>
    Effect.gen(function* () {
      const first = yield* call(frames, { source: BOUNCE, range: "0f..-1f", target: "standard" })
      expect(first.sheets).toHaveLength(4)
      expect(first.sheets[0]!.label).toMatch(/^Sheet 1 of 4\+ · clip1 · /)
      expect(first.next).not.toBeNull()
      expect(first.note).toMatch(/^Showing \d+ of 90 frames\. Pass cursor=/)
      const rest = yield* call(frames, {
        source: BOUNCE,
        range: "0f..-1f",
        target: "standard",
        cursor: first.next
      })
      const seen = [...first.sheets, ...rest.sheets].flatMap((s) => s.frames.map((f) => f.index))
      expect(seen.length).toBeGreaterThan(first.sheets.flatMap((s) => s.frames).length)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("refuses more than 100 frames unless uncapped, and checks follow's box", () =>
    Effect.gen(function* () {
      const capped = yield* failure(frames, { source: "synthetic:bounce?frames=150", range: "0f..-1f" })
      expect(capped._tag).toBe("FrameCapExceeded")
      const noBox = yield* failure(frames, { source: BOUNCE, at: ["0f"], view: "follow" })
      expect(noBox.hint).toContain("box=")
      const followed = yield* call(frames, {
        source: BOUNCE,
        range: "15f..20f",
        view: "follow",
        box: "400,120,120,120"
      })
      expect(followed.sheets[0]!.label).toContain("follow 400,120,120,120")
    }).pipe(Effect.provide(fresh))
  )

  it.effect("bad and foreign addresses fail with the address error", () =>
    Effect.gen(function* () {
      const bad = yield* failure(frames, { source: BOUNCE, at: ["8s10"] })
      expect(bad._tag).toBe("AddressParseError")
      expect(bad.message).toContain('"8s10" is not an address. Use 08s10f')
      const past = yield* failure(frames, { source: BOUNCE, at: ["5s"] })
      expect(past._tag).toBe("AddressOutOfRange")
      yield* call(probe, { source: "synthetic:cut" })
      const other = yield* failure(frames, { source: BOUNCE, at: ["clip2@0f"] })
      expect(other.message).toContain("names source clip2")
    }).pipe(Effect.provide(fresh))
  )
})

describe("scan", () => {
  it.effect("samples within budget, summarises motion and suggests ranges frames accepts", () =>
    Effect.gen(function* () {
      const out = yield* call(scan, { source: BOUNCE, budget: 8 })
      expect(out.frames).toHaveLength(8)
      expect(out.frames[0]!.address).toBe("0f")
      expect(out.frames[7]!.address).toBe("02s29f")
      expect(out.sheets[0]!.label).toBe("Sheet 1 of 1 · clip1 · 0f–02s29f · 8 frames, uneven spacing")
      expect(out.motion.peaks.length).toBeGreaterThan(0)
      expect(out.note).toMatch(/^Showing 8 of 90 frames\. Pass range=/)
      expect(out.suggestions.length).toBeGreaterThan(0)
      for (const s of out.suggestions) yield* call(frames, { source: "clip1", range: s.range })
      // Peaks are saved as markers, so they are addressable afterwards.
      const atPeak = yield* call(frames, { source: "clip1", at: ["@peak1"] })
      expect(atPeak.frames[0]!.address).toBe(out.motion.peaks[0]!.address)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("finds a hard cut and suggests looking around it", () =>
    Effect.gen(function* () {
      const out = yield* call(scan, { source: "synthetic:cut?at=45", sample: "cuts", budget: 6 })
      expect(out.cuts.map((c) => [c.name, c.kind, c.address])).toEqual([["cut1", "hard", "01s15f"]])
      expect(out.frames.map((f) => f.address)).toEqual(expect.arrayContaining(["01s14f", "01s15f"]))
      expect(out.suggestions.some((s) => s.reason.includes("cut1"))).toBe(true)
    }).pipe(Effect.provide(fresh))
  )
})

describe("compare", () => {
  it.effect("pairs sheets and reports per-address change", () =>
    Effect.gen(function* () {
      const same = yield* call(compare, { a: BOUNCE, b: BOUNCE, at: ["0f", "1s"] })
      expect(same.changes.map((c) => c.meanDiff)).toEqual([0, 0])
      expect(same.summary.changed).toBe(0)
      const eased = yield* call(compare, {
        a: "synthetic:ease?easing=linear",
        b: "synthetic:ease?easing=ease-out",
        range: "0f..-1f:10f",
        view: "diff"
      })
      expect(eased.sheets[0]!.label).toMatch(/^Sheet 1 of \d · clip2 vs clip3 · diff · 0f–/)
      expect(eased.changes[0]!.meanDiff).toBe(0)
      expect(eased.summary.changed).toBeGreaterThan(3)
    }).pipe(Effect.provide(fresh))
  )
})

describe("track", () => {
  it.effect("returns ground-truth keyframes and fits the easing that drew them", () =>
    Effect.gen(function* () {
      const out = yield* call(track, {
        source: "synthetic:ease?easing=ease-out",
        props: ["box.x"],
        fitEasing: true,
        plot: true
      })
      expect(out.method).toBe("source")
      const x = out.tracks[0]!
      expect(x.keyframes[0]!.address).toBe("0f")
      expect(x.samples).toBeUndefined()
      expect(out.easing[0]!.best.family).toBe("ease-out")
      expect(out.plot?.label).toBe("Plot · clip1 · 0f–02s29f · box.x")
      expect(existsSync(out.plot!.path)).toBe(true)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("measures a box by template matching; select is for web sources only", () =>
    Effect.gen(function* () {
      const out = yield* call(track, {
        source: BOUNCE,
        box: "40,138,43,43",
        range: "0f..20f",
        format: "detailed"
      })
      expect(out.method).toBe("template")
      expect(out.tracks.map((t) => t.name)).toEqual(["box.x", "box.y", "box.confidence"])
      expect(out.tracks[0]!.samples).toHaveLength(21)
      const select = yield* failure(track, { source: BOUNCE, select: "#hero" })
      expect(select._tag).toBe("InvalidInput")
      expect(select.hint).toContain("box=")
    }).pipe(Effect.provide(fresh))
  )
})

describe("check", () => {
  it.effect("finds a flicker and suggests a frames call that works as given", () =>
    Effect.gen(function* () {
      const out = yield* call(check, { source: "synthetic:flicker?at=40", rules: ["flicker"] })
      const [flicker] = out.findings
      expect(flicker).toMatchObject({ rule: "flicker", address: "01s10f" })
      expect(flicker!.suggest.command).toBe("kymo frames clip1 --at 01s09f 01s10f 01s11f --view diff")
      const shown = yield* call(frames, flicker!.suggest.arguments)
      expect(shown.frames.map((f) => f.address)).toEqual(["01s09f", "01s10f", "01s11f"])
      expect(out.pass).toBe(false)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("evaluates assertions over source tracks, motion and markers", () =>
    Effect.gen(function* () {
      const out = yield* call(check, {
        source: BOUNCE,
        rules: ["black-frames"],
        assert: ["@impact1 within #18..#22", "box.x <= 100 at 1s", "motion >= 0"]
      })
      expect(out.assertions.map((a) => a.pass)).toEqual([true, false, true])
      expect(out.pass).toBe(false)
    }).pipe(Effect.provide(fresh))
  )

  it.effect("runs safe-area on a synthetic scene's ground-truth box", () =>
    Effect.gen(function* () {
      const out = yield* call(check, { source: "synthetic:safe-area", rules: ["safe-area"] })
      expect(out.findings.map((f) => f.rule)).toEqual(["safe-area"])
      expect(out.findings[0]!.suggest.arguments.view).toBe("grid")
    }).pipe(Effect.provide(fresh))
  )
})

describe("record", () => {
  it.effect("is honestly unavailable", () =>
    Effect.gen(function* () {
      const e = yield* failure(record, { source: "screen", duration: "5s" })
      expect(e._tag).toBe("AdapterUnavailable")
      expect(e.message).toBe("Live recording arrives in a later release; freeze a file and open it instead.")
    }).pipe(Effect.provide(fresh))
  )
})
