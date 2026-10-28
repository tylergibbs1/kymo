import { Schema } from "effect"

const fields = { message: Schema.String, hint: Schema.String }

export class AddressParseError extends Schema.TaggedError<AddressParseError>()("AddressParseError", fields) {}
export class AddressOutOfRange extends Schema.TaggedError<AddressOutOfRange>()("AddressOutOfRange", fields) {}
export class NotSeekable extends Schema.TaggedError<NotSeekable>()("NotSeekable", fields) {}
export class FrameCapExceeded extends Schema.TaggedError<FrameCapExceeded>()("FrameCapExceeded", fields) {}
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", fields) {}
export class SourceNotFound extends Schema.TaggedError<SourceNotFound>()("SourceNotFound", fields) {}
export class AdapterUnavailable extends Schema.TaggedError<AdapterUnavailable>()(
  "AdapterUnavailable",
  fields
) {}
export class Timeout extends Schema.TaggedError<Timeout>()("Timeout", fields) {}
/** A backend (ffmpeg, sharp, the file system) failed in a way the caller cannot fix by changing input. */
export class BackendFailure extends Schema.TaggedError<BackendFailure>()("BackendFailure", fields) {}

export const KymoError = Schema.Union([
  AddressParseError,
  AddressOutOfRange,
  NotSeekable,
  FrameCapExceeded,
  InvalidInput,
  SourceNotFound,
  AdapterUnavailable,
  Timeout,
  BackendFailure
])
export type KymoError = typeof KymoError.Type

/**
 * CLI exit code when a command ran and printed its result, but the result is a failure: a check
 * with `pass: false`. Errors use 2 and above (`exitCodes`), so 1 always means "the answer is no".
 */
export const VERDICT_FAILED_EXIT = 1

/**
 * CLI exit code per error tag. Typed as a total record, so adding an error
 * without choosing its exit code is a compile error.
 */
export const exitCodes: { readonly [K in KymoError["_tag"]]: number } = {
  AddressParseError: 2,
  AddressOutOfRange: 2,
  NotSeekable: 2,
  FrameCapExceeded: 2,
  InvalidInput: 2,
  SourceNotFound: 3,
  AdapterUnavailable: 4,
  Timeout: 5,
  BackendFailure: 6
}

/** The wire shape of an error: JSON on CLI stderr, and the body of an MCP `isError` result. */
export const ErrorPayload = Schema.Struct({ tag: Schema.String, message: Schema.String, hint: Schema.String })
export type ErrorPayload = typeof ErrorPayload.Type

export const toPayload = (e: KymoError): ErrorPayload => ({ tag: e._tag, message: e.message, hint: e.hint })
