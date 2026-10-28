import { BackendFailure } from "@kymo/core"
import { Effect } from "effect"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const failure = (path: string) => (cause: unknown) =>
  new BackendFailure({
    message: `Could not write ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    hint: "Check that the output directory is writable and the disk is not full."
  })

let sequence = 0

/**
 * Write bytes to `outDir/name` atomically: readers never see a half-written PNG, and the
 * temporary file is removed even if the write fails or is interrupted.
 */
export const writeFileAtomic = (outDir: string, name: string, bytes: Uint8Array) => {
  const path = join(outDir, name)
  return Effect.acquireUseRelease(
    Effect.sync(() => `${path}.${process.pid}.${sequence++}.tmp`),
    (tmp) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(outDir, { recursive: true })
          await writeFile(tmp, bytes)
          await rename(tmp, path)
          return path
        },
        catch: failure(path)
      }),
    (tmp) => Effect.promise(() => rm(tmp, { force: true }))
  )
}
