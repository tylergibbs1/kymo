/**
 * The scripted oracle: a deterministic agent that follows the skill loop (probe, then check, scan or
 * track) and answers from `structuredContent` alone. It never sees the answer and never reads pixels,
 * so a task it fails is a task the tools do not make solvable — that is the baseline every model run is
 * compared against, and the end-to-end check that the server's results carry what an agent needs.
 */
import { Address } from "@kymo/core"
import { type CheckFinding, CheckOutput, ProbeOutput, ScanOutput, TrackOutput } from "kymo"
import { Effect, Option, Result, Schema } from "effect"
import type { Conversation, ModelBackend, Session, Turn } from "../Model.ts"
import { classifyEasing } from "../Synthetic.ts"
import { EasingLabel, type Box, type Clock } from "../Task.ts"
import type { JsonObject, ToolOutcome, ToolSpec } from "../Tools.ts"

/**
 * Results decoded with the published output schema of the tool that produced them. The oracle reads
 * results only through these, so a change to an op's output shape fails here instead of silently
 * reading nothing.
 */
const outputs = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  outcomes: ReadonlyArray<ToolOutcome>
): Array<S["Type"]> =>
  outcomes.flatMap((o) =>
    o.isError
      ? []
      : Option.toArray(Schema.decodeUnknownOption(schema)(o.structured) as Option.Option<S["Type"]>)
  )

type Request = { readonly tool: string; readonly args: JsonObject }
type Plan = {
  readonly requests: ReadonlyArray<Request>
  /** The answer value, or why there is none. */
  readonly conclude: (outcomes: ReadonlyArray<ToolOutcome>) => Result.Result<string, string>
}

const propertiesOf = (spec: ToolSpec | undefined): JsonObject => {
  const p = spec?.inputSchema["properties"]
  return typeof p === "object" && p !== null ? (p as JsonObject) : {}
}

/** Keep only the arguments the server's schema has; format a box the way the schema types it. */
const fitArgs = (spec: ToolSpec | undefined, wanted: JsonObject): JsonObject => {
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

const resolveOn = (clock: Clock, text: string): Array<number> => {
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
const framesOf = (clock: Clock, f: CheckFinding): Array<number> =>
  f.span === undefined ? [f.index] : resolveOn(clock, f.span)

const trackEnding = (
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

/** Frames where the subject stops moving right: a wall contact. */
export const contacts = (x: ReadonlyArray<number | null>, eps = 0.5): Array<number> => {
  const out: Array<number> = []
  for (let i = 1; i < x.length - 1; i++) {
    const [a, b, c] = [x[i - 1], x[i], x[i + 1]]
    if (a == null || b == null || c == null) continue
    if (b - a > eps && c - b <= eps) out.push(i)
  }
  return out
}

const easingFromTrack = (x: ReadonlyArray<number | null>): Result.Result<string, string> => {
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

const planFor = (session: Session, tools: ReadonlyArray<ToolSpec>): Plan => {
  const { source, clock } = session
  const { givens } = session
  const spec = (name: string) => tools.find((t) => t.name === name)
  const req = (tool: string, wanted: JsonObject): Request => ({
    tool,
    args: fitArgs(spec(tool), { source, ...wanted })
  })
  const probe = req("kymo_probe", {})
  const track = (subject: Box, fit: boolean) =>
    req("kymo_track", {
      box: subject,
      range: "0f..-1f",
      props: ["x", "y", "w", "h"],
      format: "detailed",
      ...(fit ? { fitEasing: true } : {})
    })
  const findings = (outcomes: ReadonlyArray<ToolOutcome>, rule: string) =>
    outputs(CheckOutput, outcomes)
      .flatMap((o) => o.findings)
      .filter((f) => f.rule === rule)

  switch (givens._tag) {
    case "flicker":
      return {
        requests: [probe, req("kymo_check", { rules: ["flicker"] })],
        conclude: (o) => {
          const f = findings(o, "flicker")[0]
          return f ? Result.succeed(`#${f.index}`) : Result.fail("check reported no flicker")
        }
      }
    case "dropped":
      return {
        requests: [probe, req("kymo_check", { rules: ["duplicate-frames"] })],
        conclude: (o) => {
          const frames = [
            ...new Set(findings(o, "duplicate-frames").flatMap((f) => framesOf(clock, f)))
          ].sort((a, b) => a - b)
          return frames.length > 0
            ? Result.succeed(frames.map((i) => `#${i}`).join(", "))
            : Result.fail("check reported no repeats")
        }
      }
    case "cut":
      return {
        requests: [probe, req("kymo_scan", { sample: "cuts", budget: 6 })],
        conclude: (o) => {
          const first = outputs(ScanOutput, o)
            .flatMap((r) => r.cuts)
            .flatMap((c) => resolveOn(clock, c.from))
            .sort((a, b) => a - b)[0]
          return first === undefined ? Result.fail("scan reported no cut") : Result.succeed(`#${first + 1}`)
        }
      }
    case "impact":
      return {
        requests: [probe, track(givens.subject, false)],
        conclude: (o) =>
          Result.flatMap(trackEnding(o, ".x"), (x) => {
            const hit = contacts(x)[0]
            return hit === undefined
              ? Result.fail("the x track never stops moving right")
              : Result.succeed(`#${hit}`)
          })
      }
    case "bounces":
      return {
        requests: [probe, track(givens.subject, false)],
        conclude: (o) => Result.map(trackEnding(o, ".x"), (x) => String(contacts(x).length))
      }
    case "easing":
      return {
        requests: [probe, track(givens.subject, true)],
        conclude: (o) => {
          const fit = outputs(TrackOutput, o).flatMap((r) => r.easing)[0]?.best.family
          if (fit !== undefined && Schema.is(EasingLabel)(fit)) return Result.succeed(fit)
          return Result.flatMap(trackEnding(o, ".x"), easingFromTrack)
        }
      }
    case "safe-area":
      return {
        requests: [probe, track(givens.subject, false)],
        conclude: (o) => {
          const size = outputs(ProbeOutput, o)[0]?.size
          if (!size) return Result.fail("probe reported no frame size")
          const m = givens.marginPercent / 100
          return Result.flatMap(trackEnding(o, ".x"), (x) =>
            Result.flatMap(trackEnding(o, ".w"), (w) => {
              const i = x.findIndex(
                (xi, k) =>
                  xi != null && w[k] != null && (xi < m * size.width || xi + w[k]! > (1 - m) * size.width)
              )
              return i < 0 ? Result.fail("the box never leaves the safe area") : Result.succeed(`#${i}`)
            })
          )
        }
      }
    case "clip":
      return {
        requests: [probe],
        conclude: () => Result.fail("the oracle has no strategy for open-ended clips")
      }
  }
}

const NO_USAGE = { inputTokens: 0, outputTokens: 0 }

export const oracle: ModelBackend = {
  id: "oracle",
  start: (session) =>
    Effect.sync((): Conversation => {
      const plan = planFor(session, session.tools)
      const outcomes: Array<ToolOutcome> = []
      let next = 0
      const reply = (text: string): Turn => ({ text, calls: [], usage: NO_USAGE, refused: false })
      return {
        send: (input) =>
          Effect.sync((): Turn => {
            if (input._tag === "results") outcomes.push(...input.results.map((r) => r.outcome))
            else if (next >= plan.requests.length)
              return reply("ANSWER: unknown (no strategy for follow-up questions)")
            const request = plan.requests[next]
            if (request) {
              next++
              if (!session.tools.some((t) => t.name === request.tool)) {
                return reply(`The server has no ${request.tool} tool.\nANSWER: unknown`)
              }
              return {
                text: "",
                calls: [{ id: `oracle-${next}`, name: request.tool, args: request.args }],
                usage: NO_USAGE,
                refused: false
              }
            }
            return Result.match(plan.conclude(outcomes), {
              onSuccess: (value) => reply(`Read from structuredContent.\nANSWER: ${value}`),
              onFailure: (why) => reply(`${why}.\nANSWER: unknown`)
            })
          })
      }
    })
}
