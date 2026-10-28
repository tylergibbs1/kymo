import { AdapterUnavailable, BackendFailure } from "@kymo/core"
import { Effect, type PlatformError, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"

/**
 * How every ffmpeg/ffprobe process is started. SIGKILL on scope close: on SIGTERM ffmpeg tries to
 * flush, and blocks forever if the reader has stopped draining its stdout pipe.
 */
export const command = (binary: string, args: ReadonlyArray<string>) =>
  ChildProcess.make(binary, args, { stdin: "ignore", killSignal: "SIGKILL" })

/** Spawn failures: a vanished binary is AdapterUnavailable, anything else a BackendFailure. */
export const spawnFailure = (binary: string) => (error: PlatformError.PlatformError) =>
  error.reason._tag === "NotFound" || error.reason._tag === "PermissionDenied"
    ? new AdapterUnavailable({
        message: `${binary} could not be started: ${error.message}`,
        hint: "Install ffmpeg, or point KYMO_FFMPEG / KYMO_FFPROBE at working binaries."
      })
    : new BackendFailure({
        message: `${binary} failed: ${error.message}`,
        hint: "Check that the file is readable and retry."
      })

export interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Run a command to completion and collect its output as text. */
export const run = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  binary: string,
  args: ReadonlyArray<string>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command(binary, args))
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode
        ],
        { concurrency: "unbounded" }
      )
      return { stdout, stderr, exitCode: Number(exitCode) } satisfies RunResult
    })
  ).pipe(Effect.mapError(spawnFailure(binary)))

/** The last few lines of stderr, enough to diagnose without flooding the message. */
export const stderrTail = (stderr: string) => stderr.trim().split("\n").slice(-3).join(" | ")
