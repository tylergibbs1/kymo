/**
 * Loading tasks. Synthetic tasks live in `eval/tasks/synthetic.json`, generated from ground truth
 * (`npm run eval -- tasks`) and checked in so task changes show up in review. Real clips are listed
 * in `eval/tasks/clips.json`; their files are fetched separately and are never committed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import type { KymoError } from "@kymo/core"
import { Sources } from "@kymo/sources"
import { Effect, Schema } from "effect"
import { answerFormat } from "./Prompts.ts"
import { splitOf } from "./Split.ts"
import { Answer, FollowUp, type Task, TaskFile } from "./Task.ts"

export const ClipCategory = Schema.Literals([
  "ui-animation",
  "promo",
  "screen-recording",
  "dashcam",
  "telemetry+video"
])

/** One real clip and the question asked about it. Multi-step tasks add follow-ups. */
export const ClipEntry = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)),
  category: ClipCategory,
  /** Path to the clip, relative to the manifest. */
  file: Schema.String,
  /** Where the clip came from, and its licence. Provenance only; nothing is downloaded. */
  origin: Schema.Struct({ url: Schema.String, license: Schema.String }),
  prompt: Schema.String,
  answer: Answer,
  followUps: Schema.optionalKey(Schema.Array(FollowUp))
})
export type ClipEntry = typeof ClipEntry.Type

export const ClipManifest = Schema.Struct({ clips: Schema.Array(ClipEntry) })

export class TaskFileInvalid extends Schema.TaggedError<TaskFileInvalid>()("TaskFileInvalid", {
  path: Schema.String,
  message: Schema.String
}) {}

/** Read and decode a JSON file; any failure names the file. */
export const readJson = <A>(path: string, schema: Schema.Codec<A, unknown>) =>
  Effect.try({
    try: () => JSON.parse(readFileSync(path, "utf8")) as unknown,
    catch: (cause) =>
      new TaskFileInvalid({ path, message: cause instanceof Error ? cause.message : String(cause) })
  }).pipe(
    Effect.flatMap((json) =>
      Effect.mapError(
        Schema.decodeUnknownEffect(schema)(json),
        (e) => new TaskFileInvalid({ path, message: e.message })
      )
    )
  )

export const loadTaskFile = (path: string): Effect.Effect<ReadonlyArray<Task>, TaskFileInvalid> =>
  Effect.map(readJson(path, TaskFile), (f) => f.tasks)

export const writeTaskFile = (path: string, tasks: ReadonlyArray<Task>): void =>
  writeFileSync(path, `${JSON.stringify(Schema.encodeSync(TaskFile)({ tasks }), null, 2)}\n`)

export interface ClipLoad {
  readonly tasks: ReadonlyArray<Task>
  /** Manifest entries whose file is not on disk. */
  readonly missing: ReadonlyArray<string>
}

/** Read the clip manifest and open each present clip once to learn its clock. */
export const loadClips = (manifest: string): Effect.Effect<ClipLoad, TaskFileInvalid | KymoError, Sources> =>
  Effect.gen(function* () {
    if (!existsSync(manifest)) return { tasks: [], missing: [] }
    const { clips } = yield* readJson(manifest, ClipManifest)
    const sources = yield* Sources
    const tasks: Array<Task> = []
    const missing: Array<string> = []
    for (const clip of clips) {
      const file = isAbsolute(clip.file) ? clip.file : resolve(dirname(manifest), clip.file)
      if (!existsSync(file)) {
        missing.push(clip.id)
        continue
      }
      const timeline = yield* Effect.scoped(Effect.map(sources.open(file, "clip"), (s) => s.timeline))
      tasks.push({
        id: clip.id,
        split: splitOf(clip.id),
        source: file,
        clock: { rate: timeline.rate, frames: timeline.frameCount },
        givens: { _tag: "clip", category: clip.category },
        prompt: `${clip.prompt}\n\n${answerFormat[clip.answer._tag]}`,
        answer: clip.answer,
        followUps: clip.followUps ?? []
      })
    }
    return { tasks, missing }
  })
