/**
 * What the oracle's strategies share: tool requests fitted to the server's schemas, and tool results
 * read through the published output schemas only.
 */
import { Address } from "@kymo/core"
import { type CheckFinding, CheckOutput, TrackOutput } from "kymo"
import { Option, Result, Schema } from "effect"
import { classifyEasing } from "../Synthetic.ts"
import type { Box, Clock } from "../Task.ts"
import type { JsonObject, ToolOutcome, ToolSpec } from "../Tools.ts"

/**
 * Results decoded with the published output schema of the tool that produced them. The oracle reads
 * results only through these, so a change to an op's output shape fails here instead of silently
 * reading nothing.
 */
export const outputs = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  outcomes: ReadonlyArray<ToolOutcome>
): Array<S["Type"]> =>
  outcomes.flatMap((o) =>
    o.isError
      ? []
      : Option.toArray(Schema.decodeUnknownOption(schema)(o.structured) as Option.Option<S["Type"]>)
  )

export type Request = { readonly tool: string; readonly args: JsonObject }
export type Plan = {
  readonly requests: ReadonlyArray<Request>
  /** The answer value, or why there is none. Outcomes come in request order. */
  readonly conclude: (outcomes: ReadonlyArray<ToolOutcome>) => Result.Result<string, string>
}

const propertiesOf = (spec: ToolSpec | undefined): JsonObject => {
  const p = spec?.inputSchema["properties"]
  return typeof p === "object" && p !== null ? (p as JsonObject) : {}
}

/** Keep only the arguments the server's schema has; format a box the way the schema types it. */
export const fitArgs = (spec: ToolSpec | undefined, wanted: JsonObject): JsonObject => {
  const props = propertiesOf(spec)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(wanted)) {
    const prop = props[key]
    if (prop === undefined) continue
    if (key === "box") {
      const b = value as Box
      const type = (prop as { type?: unknown }).type
      out[key] =
        type === "object" ? b : type === "array" ? [b.x, b.y, b.w, b.h] : `${b.x},${b.y},${b.w},${b.h}`
    } else out[key] = value
  }
  return out
}

export const resolveOn = (clock: Clock, text: string): Array<number> => {
  const ctx: Address.ResolveContext = {
    handle: "o",
    kind: "o",
    rate: clock.rate,
    first: 0,
    count: clock.frames,
    live: false,
    markers: []
  }
  const resolved = Result.flatMap(Address.parse(text), (a) => Address.resolve(ctx, a))
  return Result.isSuccess(resolved) ? [...resolved.success] : []
}

/** Frames a finding covers: its index, or every frame in its span. */
export const framesOf = (clock: Clock, f: CheckFinding): Array<number> =>
  f.span === undefined ? [f.index] : resolveOn(clock, f.span)

/** Findings of one rule, across every check result. */
export const findingsOf = (outcomes: ReadonlyArray<ToolOutcome>, rule: string): Array<CheckFinding> =>
  outputs(CheckOutput, outcomes)
    .flatMap((o) => o.findings)
    .filter((f) => f.rule === rule)

/** A detailed track's samples by frame index, null where unknown. */
export const trackEnding = (
  outcomes: ReadonlyArray<ToolOutcome>,
  suffix: string
): Result.Result<ReadonlyArray<number | null>, string> => {
  const track = outputs(TrackOutput, outcomes)
    .flatMap((o) => o.tracks)
    .find((t) => t.name.endsWith(suffix))
  if (!track?.samples) return Result.fail(`no detailed track ending in ${suffix} in the results`)
  const dense: Array<number | null> = []
  for (const s of track.samples) dense[s.index] = s.value
  return Result.succeed(Array.from(dense, (v) => v ?? null))
}

/** How a strategy builds a request: the source is filled in and the arguments fitted to the schema. */
export type Requester = (tool: string, wanted: JsonObject) => Request

/** Name the easing of a track that moves once, from its samples alone. */
export const easingFromTrack = (x: ReadonlyArray<number | null>): Result.Result<string, string> => {
  const v = x.map((s) => s ?? Number.NaN)
  const x0 = v[0]!
  const x1 = v[v.length - 1]!
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 === x0) return Result.fail("the track does not move")
  const progress = v.map((s) => (s - x0) / (x1 - x0))
  const start = Math.max(0, progress.findIndex((p) => p > 0.002) - 1)
  const end = progress.findIndex((p, i) => i > start && Math.abs(1 - p) < 0.002)
  const label = classifyEasing(progress, start, end < 0 ? progress.length - 1 : end, 1.02)
  return label ? Result.succeed(label) : Result.fail("the track matches no known easing")
}
