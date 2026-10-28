/** The only place the CLI writes: one JSON value or JSON Lines on stdout, JSON errors on stderr. */
import type { ErrorPayload } from "@kymo/core"
import { Effect } from "effect"

const write = (stream: NodeJS.WriteStream, text: string) =>
  Effect.callback<void>((resume) => {
    stream.write(text, () => resume(Effect.void))
  })

/** One JSON value on stdout. */
export const json = (value: unknown) => write(process.stdout, `${JSON.stringify(value)}\n`)

/** JSON Lines on stdout: one value per line. */
export const lines = (values: ReadonlyArray<unknown>) =>
  write(process.stdout, values.map((v) => `${JSON.stringify(v)}\n`).join(""))

/** Help text the user asked for (`--help`), on stdout. */
export const help = (text: string) => write(process.stdout, text.endsWith("\n") ? text : `${text}\n`)

/** `{tag, message, hint}` on stderr. */
export const error = (payload: ErrorPayload) => write(process.stderr, `${JSON.stringify(payload)}\n`)
