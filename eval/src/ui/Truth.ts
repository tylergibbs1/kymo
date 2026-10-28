/**
 * What a browser capture recorded, frame by frame: every tracked element's box and on-screen opacity
 * (`dialog.x`, `dialog.opacity`, …). `eval/ui/truth.json` holds it for every capture in the case list,
 * keyed by a hash of the scene's files and parameters, so tasks regenerate from it without a browser
 * and a scene edited without recapturing is caught by its key.
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Effect, Schema } from "effect"
import { type TaskFileInvalid, readJson } from "../TaskSet.ts"

export const SCENES_DIR = join(import.meta.dirname, "../../ui/scenes")
export const TRUTH_FILE = join(import.meta.dirname, "../../ui/truth.json")

/** Bump when capture changes what it records or how it encodes, so every key changes with it. */
const CAPTURE_VERSION = 1
export const VIEWPORT = { width: 1280, height: 720 } as const

export const SceneName = Schema.Literals([
  "modal",
  "spring",
  "toast",
  "janky",
  "transition",
  "safearea",
  "compare"
])
export type SceneName = typeof SceneName.Type

/** One rendering: a scene page, its query parameters, and the H.264 quality it is encoded at. */
export interface CaptureSpec {
  readonly scene: SceneName
  readonly params: Readonly<Record<string, string | number>>
  /** x264 constant rate factor: 23 is the usual default; higher compresses harder. */
  readonly crf: number
}

export const queryOf = (spec: CaptureSpec): string =>
  new URLSearchParams(
    Object.entries(spec.params).map(([k, v]): [string, string] => [k, String(v)])
  ).toString()

const SHARED_FILES = ["scene.js", "common.css"]

/** A hash of everything that decides the pixels and the truth: scene files, parameters, encoding. */
export const captureKey = (spec: CaptureSpec): string => {
  const hash = createHash("sha256").update(
    JSON.stringify({
      version: CAPTURE_VERSION,
      viewport: VIEWPORT,
      scene: spec.scene,
      query: queryOf(spec),
      crf: spec.crf
    })
  )
  for (const file of [`${spec.scene}.html`, ...SHARED_FILES])
    hash.update(readFileSync(join(SCENES_DIR, file)))
  return hash.digest("hex").slice(0, 16)
}

/** A capture's cache directory, under the eval cache root; its footage is `clip.mp4` inside. */
export const captureDir = (cacheDir: string, key: string): string => join(cacheDir, "ui", key)
export const FOOTAGE_FILE = "clip.mp4"
export const footagePath = (cacheDir: string, key: string): string =>
  join(captureDir(cacheDir, key), FOOTAGE_FILE)

/** A value per frame, or one number when it never changes. */
const Column = Schema.Union([Schema.Finite, Schema.Array(Schema.Finite)])

export const CaptureTruth = Schema.Struct({
  key: Schema.String,
  scene: SceneName,
  query: Schema.String,
  crf: Schema.Int,
  fps: Schema.Int.check(Schema.isGreaterThan(0)),
  frames: Schema.Int.check(Schema.isGreaterThan(0)),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  tracks: Schema.Record(Schema.String, Column)
})
export type CaptureTruth = typeof CaptureTruth.Type

export const TruthFile = Schema.Struct({ captures: Schema.Array(CaptureTruth) })
export type TruthFile = typeof TruthFile.Type

/** Every value of a track, one per frame. */
export const series = (truth: CaptureTruth, name: string): ReadonlyArray<number> | undefined => {
  const column = truth.tracks[name]
  if (column === undefined) return undefined
  return typeof column === "number" ? Array.from({ length: truth.frames }, () => column) : column
}

/** Round to a thousandth and fold constant tracks to one number, so the checked-in file stays small. */
export const compact = (
  rows: ReadonlyArray<Readonly<Record<string, number>>>
): Record<string, number | Array<number>> => {
  const out: Record<string, number | Array<number>> = {}
  for (const name of Object.keys(rows[0] ?? {}).sort()) {
    const values = rows.map((r) => Math.round((r[name] ?? Number.NaN) * 1000) / 1000)
    out[name] = values.every((v) => v === values[0]) ? values[0]! : values
  }
  return out
}

export const loadTruth = (path: string = TRUTH_FILE): Effect.Effect<TruthFile, TaskFileInvalid> =>
  readJson(path, TruthFile)

/** One capture per line: small diffs when a single capture changes. */
export const writeTruth = (file: TruthFile, path: string = TRUTH_FILE): void => {
  const lines = file.captures.map((c) => `    ${JSON.stringify(Schema.encodeSync(CaptureTruth)(c))}`)
  writeFileSync(path, `{\n  "captures": [\n${lines.join(",\n")}\n  ]\n}\n`)
}
