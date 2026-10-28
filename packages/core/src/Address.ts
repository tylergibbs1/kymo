/**
 * The frame-address grammar.
 *
 *   address  := [handle "@"] point | range
 *   point    := timecode | "#" int | seconds | "-" timecode | "now" ["-" timecode] | "@" marker [("+"|"-") timecode]
 *   timecode := [int "h"] [int "m"] [int "s"] [int "f"]      08s10f · 01m05s · 02m00s24f · 0f
 *   seconds  := number "s" | number "ms"                     8.33s · 500ms
 *   range    := point ".." point [":" step]                  2s..4s:2f · #0..#90:10
 *
 * `parse` turns text into an Address; `resolve` turns an Address into frame
 * indices against one Timeline; `format` is the canonical inverse.
 *
 * On a constant-rate clock a timecode counts frames (`08s10f` is 8 × base + 10 frames). On a
 * variable-rate clock (see `variableRate`) seconds are time and frames are frames: `16s`, `8.33s`
 * and `-2s` name the frame on screen at that time, while `5f`, `-1f`, `@cut1+5f` and `:2f` count
 * decoded frames. `format` then writes the frame's own start time (`16.04s`), so a label never
 * disagrees with the frame's `t`.
 */
import { Effect, Result, Schema } from "effect"
import { AddressOutOfRange, AddressParseError, NotSeekable } from "./Errors.ts"
import {
  type FrameIndex,
  type Rate,
  clockOf,
  frameIndex,
  indexAtSeconds,
  secondsAt,
  timecodeBase
} from "./Rate.ts"

/** A length of time, as written. Converted to frames only once a Rate is known. */
export type Span =
  | {
      readonly _tag: "Timecode"
      readonly h: number
      readonly m: number
      readonly s: number
      readonly f: number
    }
  | { readonly _tag: "Seconds"; readonly seconds: number }

export type Point =
  | { readonly _tag: "FromStart"; readonly span: Span }
  | { readonly _tag: "Index"; readonly index: number }
  | { readonly _tag: "FromEnd"; readonly span: Span }
  | { readonly _tag: "Now"; readonly minus: Span | undefined }
  | {
      readonly _tag: "Marker"
      readonly name: string
      readonly offset: number
      readonly span: Span | undefined
    }

export type Spec =
  | { readonly _tag: "Point"; readonly point: Point }
  | { readonly _tag: "Range"; readonly from: Point; readonly to: Point; readonly step: Span | undefined }

export interface Address {
  readonly text: string
  readonly handle: string | undefined
  readonly spec: Spec
}

const EXAMPLES = "Use 08s10f, #250, 8.33s, -1f, @marker or a range like 2s..4s:2f."

const fail = (text: string, why?: string) =>
  new AddressParseError({
    message: `"${text}" is not an address.${why ? ` ${why}.` : ""} ${EXAMPLES}`,
    hint: EXAMPLES
  })

const TIMECODE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)f)?$/
const SECONDS = /^(\d+(?:\.\d+)?|\.\d+)(s|ms)$/
const HANDLE = /^([A-Za-z_][\w-]*)@(.+)$/
const MARKER = /^@([A-Za-z_]\w*)(?:([+-])(.+))?$/

const parseSpan = (text: string): Span | undefined => {
  const sec = SECONDS.exec(text)
  // "8s" is both a timecode and a seconds value; they agree, so prefer the timecode (exact).
  if (sec && (sec[2] === "ms" || text.includes("."))) {
    const n = Number(sec[1])
    return { _tag: "Seconds", seconds: sec[2] === "ms" ? n / 1000 : n }
  }
  const tc = TIMECODE.exec(text)
  if (tc && text.length > 0) {
    const [, h, m, s, f] = tc
    return { _tag: "Timecode", h: Number(h ?? 0), m: Number(m ?? 0), s: Number(s ?? 0), f: Number(f ?? 0) }
  }
  return undefined
}

const isZero = (span: Span): boolean =>
  span._tag === "Seconds" ? span.seconds === 0 : span.h + span.m + span.s + span.f === 0

const parsePoint = (text: string, whole: string): Result.Result<Point, AddressParseError> => {
  if (text.startsWith("#")) {
    const digits = text.slice(1)
    return /^\d+$/.test(digits)
      ? Result.succeed({ _tag: "Index", index: Number(digits) })
      : Result.fail(fail(whole, "A frame index is # followed by digits, like #250"))
  }
  if (text === "now") return Result.succeed({ _tag: "Now", minus: undefined })
  if (text.startsWith("now-")) {
    const span = parseSpan(text.slice(4))
    return span ? Result.succeed({ _tag: "Now", minus: span }) : Result.fail(fail(whole))
  }
  if (text.startsWith("@")) {
    const m = MARKER.exec(text)
    if (!m) return Result.fail(fail(whole, "Marker names are letters, digits and _ (a - starts an offset)"))
    const [, name, sign, rest] = m
    if (sign === undefined) return Result.succeed({ _tag: "Marker", name: name!, offset: 0, span: undefined })
    const span = parseSpan(rest!)
    return span
      ? Result.succeed({ _tag: "Marker", name: name!, offset: sign === "+" ? 1 : -1, span })
      : Result.fail(fail(whole))
  }
  if (text.startsWith("-")) {
    const span = parseSpan(text.slice(1))
    return span ? Result.succeed({ _tag: "FromEnd", span }) : Result.fail(fail(whole))
  }
  const span = parseSpan(text)
  if (span) return Result.succeed({ _tag: "FromStart", span })
  if (/^\d+$/.test(text))
    return Result.fail(fail(whole, `A bare number needs a unit: ${text}f, #${text} or ${text}s`))
  return Result.fail(fail(whole))
}

/** Parse address text. Pure; never consults a Timeline. */
export const parse = (input: string): Result.Result<Address, AddressParseError> => {
  const text = input.trim()
  if (text.length === 0) return Result.fail(fail(input, "It is empty"))
  const h = HANDLE.exec(text)
  const handle = h?.[1]
  const body = h ? h[2]! : text
  const parts = body.split("..")
  if (parts.length === 1) {
    return Result.map(parsePoint(body, text), (point) => ({ text, handle, spec: { _tag: "Point", point } }))
  }
  if (parts.length !== 2) return Result.fail(fail(text, "A range has exactly one '..'"))
  const [fromText, toAndStep] = parts as [string, string]
  const [toText, stepText, extra] = toAndStep.split(":")
  if (extra !== undefined) return Result.fail(fail(text, "A range has at most one ':step'"))
  let step: Span | undefined
  if (stepText !== undefined) {
    step = /^\d+$/.test(stepText)
      ? { _tag: "Timecode", h: 0, m: 0, s: 0, f: Number(stepText) }
      : parseSpan(stepText)
    if (!step) return Result.fail(fail(text, `The step "${stepText}" is not a length like 2f or 0.5s`))
    if (isZero(step)) return Result.fail(fail(text, `A step of ${stepText} never advances; use 1f or more`))
  }
  const from = parsePoint(fromText, text)
  if (Result.isFailure(from)) return Result.fail(from.failure)
  const to = parsePoint(toText!, text)
  if (Result.isFailure(to)) return Result.fail(to.failure)
  return Result.succeed({ text, handle, spec: { _tag: "Range", from: from.success, to: to.success, step } })
}

export const parseEffect = (input: string): Effect.Effect<Address, AddressParseError> =>
  Effect.fromResult(parse(input))

/** Number of frames in a span on a constant-rate clock (on a variable one, the average rate's). */
export const spanFrames = (rate: Rate, span: Span): number =>
  span._tag === "Timecode"
    ? ((span.h * 60 + span.m) * 60 + span.s) * timecodeBase(rate) + span.f
    : Math.round((span.seconds * rate.num) / rate.den)

/** `16s`, `16.04s`, `0.5s`: a time to the millisecond, as a variable-rate clock writes its frames. */
const formatSeconds = (t: number): string => {
  const ms = Math.round(t * 1000)
  const frac = String(ms % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "")
  return `${Math.floor(ms / 1000)}${frac.length > 0 ? `.${frac}` : ""}s`
}

const UNITS = ["h", "m", "s", "f"] as const

/**
 * Canonical address of a frame index. Constant rate: a timecode with zero segments dropped at either
 * end but kept in between, so a segment never reads as another unit: `08s10f`, `01m05s`,
 * `02m00s24f` (not `02m24f`), `0f`. Minutes and seconds are two digits; frames are padded to the
 * base's width only when they follow another segment. Variable rate: the frame's start time, `16.04s`.
 */
export const format = (rate: Rate, index: number): string => {
  if (clockOf(rate) !== undefined) return formatSeconds(secondsAt(rate, index))
  const base = timecodeBase(rate)
  const totalS = Math.floor(index / base)
  const values = [Math.floor(totalS / 3600), Math.floor(totalS / 60) % 60, totalS % 60, index % base]
  const first = values.findIndex((v) => v > 0)
  if (first < 0) return "0f"
  const last = values.findLastIndex((v) => v > 0)
  const fWidth = Math.max(2, String(base - 1).length)
  const out: Array<string> = []
  for (let k = first; k <= last; k++) {
    const v = values[k]!
    const text =
      k === 0 || (k === 3 && k === first) ? String(v) : String(v).padStart(k === 3 ? fWidth : 2, "0")
    out.push(`${text}${UNITS[k]}`)
  }
  return out.join("")
}

/** How frames are labelled for people and agents: `08s10f #250` (both), `08s10f` (timecode) or `#250` (index). */
export const LabelStyle = Schema.Literals(["both", "timecode", "index"])
export type LabelStyle = typeof LabelStyle.Type

export const DEFAULT_LABEL_STYLE: LabelStyle = "both"

/** A frame's label in a style: `08s10f #250`, `08s10f` or `#250`. */
export const styledLabel = (rate: Rate, index: number, style: LabelStyle): string =>
  style === "timecode"
    ? format(rate, index)
    : style === "index"
      ? `#${index}`
      : `${format(rate, index)} #${index}`

/** The label form: timecode for reading, index for arithmetic. `08s10f #250`. */
export const label = (rate: Rate, index: number): string => styledLabel(rate, index, "both")

/** A sheet or file span name: `0f-08s10f`. */
export const spanName = (rate: Rate, first: number, last: number): string =>
  first === last ? format(rate, first) : `${format(rate, first)}-${format(rate, last)}`

/**
 * A number of frames as a length: `20f`, `01s` on a constant-rate clock. On a variable one a frame
 * count is not a time, so it stays a count: `20f`.
 */
export const formatLength = (rate: Rate, frames: number): string =>
  clockOf(rate) === undefined ? format(rate, frames) : `${frames}f`

/** What `resolve` needs to know about a Timeline. Kept narrow so tests need no source. */
export interface ResolveContext {
  readonly handle: string
  readonly kind: string
  readonly rate: Rate
  /** Frames currently addressable: [first, first + count). For files `first` is 0. */
  readonly first: number
  readonly count: number
  readonly live: boolean
  readonly markers: ReadonlyArray<{ readonly name: string; readonly index: number }>
}

type ResolveError = AddressOutOfRange | NotSeekable

const outOfRange = (ctx: ResolveContext, text: string, index: number) => {
  const last = ctx.first + ctx.count - 1
  if (ctx.live && index < ctx.first) {
    return new NotSeekable({
      message: `${text} is older than ${ctx.handle}'s buffer, which starts at ${format(ctx.rate, ctx.first)}.`,
      hint: `Use an address from now-${format(ctx.rate, ctx.count - 1)} to now, or freeze the buffer to a file.`
    })
  }
  return new AddressOutOfRange({
    message:
      index < ctx.first
        ? `${text} is before the start of ${ctx.handle}; the first frame is ${format(ctx.rate, ctx.first)} (#${ctx.first}).`
        : `${text} is past the end of ${ctx.handle}; the last frame is ${format(ctx.rate, last)} (#${last}), also written -1f.`,
    hint: `Valid frames are ${format(ctx.rate, ctx.first)} (#${ctx.first}) to ${format(ctx.rate, last)} (#${last}).`
  })
}

/** A span as time and frames: on a variable clock the two move differently. */
const partsOf = (span: Span): { readonly seconds: number; readonly frames: number } =>
  span._tag === "Seconds"
    ? { seconds: span.seconds, frames: 0 }
    : { seconds: (span.h * 60 + span.m) * 60 + span.s, frames: span.f }

/**
 * The frame `k` spans after (k > 0) or before (k < 0) frame `from`, which may be the frame count
 * (the end). Constant rate: frame arithmetic. Variable rate: the seconds move in time, to the frame
 * on screen then, and the frames count decoded frames from there.
 */
const offsetFrom = (rate: Rate, from: number, k: number, span: Span): number => {
  if (clockOf(rate) === undefined) return from + k * spanFrames(rate, span)
  const { seconds, frames } = partsOf(span)
  const at = seconds === 0 ? from : indexAtSeconds(rate, secondsAt(rate, from) + k * seconds)
  return at + k * frames
}

const resolvePoint = (ctx: ResolveContext, p: Point, text: string): Result.Result<number, ResolveError> => {
  const end = ctx.first + ctx.count
  switch (p._tag) {
    case "FromStart":
      return Result.succeed(offsetFrom(ctx.rate, 0, 1, p.span))
    case "Index":
      return Result.succeed(p.index)
    case "FromEnd":
      return Result.succeed(offsetFrom(ctx.rate, end, -1, p.span))
    case "Now":
      if (!ctx.live) {
        return Result.fail(
          new AddressOutOfRange({
            message: `${text} only works on live sources; ${ctx.handle} is a ${ctx.kind} source.`,
            hint: "Count from the end instead, e.g. -2s or -1f."
          })
        )
      }
      return Result.succeed(end - 1 - (p.minus ? spanFrames(ctx.rate, p.minus) : 0))
    case "Marker": {
      const marker = ctx.markers.find((m) => m.name === p.name)
      if (!marker) {
        const known = ctx.markers.map((m) => `@${m.name}`).join(", ")
        return Result.fail(
          new AddressOutOfRange({
            message: `${ctx.handle} has no marker @${p.name}.`,
            hint: known
              ? `Markers: ${known}.`
              : "This source has no markers yet; run scan or check to find some."
          })
        )
      }
      return Result.succeed(p.span ? offsetFrom(ctx.rate, marker.index, p.offset, p.span) : marker.index)
    }
  }
}

const inBounds = (
  ctx: ResolveContext,
  text: string,
  index: number
): Result.Result<FrameIndex, ResolveError> =>
  index >= ctx.first && index < ctx.first + ctx.count
    ? Result.succeed(frameIndex(index))
    : Result.fail(outOfRange(ctx, text, index))

/** Resolve an address to the frame indices it names, in order. */
export const resolve = (
  ctx: ResolveContext,
  address: Address
): Result.Result<ReadonlyArray<FrameIndex>, ResolveError> => {
  const { spec, text } = address
  if (spec._tag === "Point") {
    return Result.flatMap(resolvePoint(ctx, spec.point, text), (i) =>
      Result.map(inBounds(ctx, text, i), (x) => [x])
    )
  }
  const from = resolvePoint(ctx, spec.from, text)
  if (Result.isFailure(from)) return Result.fail(from.failure)
  const to = resolvePoint(ctx, spec.to, text)
  if (Result.isFailure(to)) return Result.fail(to.failure)
  const a = inBounds(ctx, text, from.success)
  if (Result.isFailure(a)) return Result.fail(a.failure)
  const b = inBounds(ctx, text, to.success)
  if (Result.isFailure(b)) return Result.fail(b.failure)
  if (b.success < a.success) {
    return Result.fail(
      new AddressOutOfRange({
        message: `${text} ends before it starts.`,
        hint: `Write the earlier address first: ${format(ctx.rate, b.success)}..${format(ctx.rate, a.success)}.`
      })
    )
  }
  const out: Array<FrameIndex> = [a.success]
  // Step k is measured from the range's start, so a time step cannot drift on a variable clock.
  for (let k = 1; ; k++) {
    const i = spec.step ? offsetFrom(ctx.rate, a.success, k, spec.step) : a.success + k
    if (i > b.success) break
    if (i > out[out.length - 1]!) out.push(frameIndex(i))
  }
  return Result.succeed(out)
}

/** Parse and resolve one address string, as an Effect. */
export const resolveText = (
  ctx: ResolveContext,
  text: string
): Effect.Effect<ReadonlyArray<FrameIndex>, AddressParseError | ResolveError> =>
  Effect.fromResult(Result.flatMap(parse(text), (a) => resolve(ctx, a)))
