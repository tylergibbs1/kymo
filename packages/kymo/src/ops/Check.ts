import {
  AssertionResult,
  Finding,
  type FrameRange,
  type RegionTrack,
  RuleName,
  check as runCheck,
  detectCuts,
  frameRef,
  motionEnergy,
  runAssertions,
  scan
} from "@kymo/analysis"
import { FramesView, type Marker, type Source, type Track } from "@kymo/core"
import { Workspace } from "@kymo/sources"
import { Effect, Schema } from "effect"
import { Range, Source as SourceField } from "../Fields.ts"
import { analysisRange } from "../Frames.ts"
import { define } from "../Operation.ts"

export const CheckInput = Schema.Struct({
  source: SourceField,
  rules: Schema.optionalKey(
    Schema.Array(RuleName).check(Schema.isMinLength(1)).annotate({
      description:
        "Lint rules to run. Default: every pixel rule (duplicate-frames, dropped-frames, flicker, black-frames), plus safe-area when the source has box.* tracks. non-monotonic runs on request, over the source's tracks."
    })
  ),
  assert: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1)))
      .check(Schema.isMinLength(1))
      .annotate({
        description:
          'Assertions over tracks and markers, e.g. "box.x <= 600 at 1s", "box.opacity >= 0.99 by 500ms", "motion < 0.01 after @impact3", "@impact1 within #15..#25". Tracks: the source\'s own plus motion; markers: the source\'s plus cut1.., peak1...'
      })
  ),
  range: Schema.optionalKey(Range)
}).annotate({ identifier: "CheckInput" })

/** The next call that shows a finding, ready to send as is. */
export const SuggestedCall = Schema.Struct({
  tool: Schema.Literal("kymo_frames"),
  arguments: Schema.Struct({ source: Schema.String, at: Schema.Array(Schema.String), view: FramesView }),
  command: Schema.String.annotate({ description: "The same call on the command line." })
}).annotate({ description: "The next call that shows the finding, ready to send as is." })

const { suggest: _analysisSuggest, ...findingFields } = Finding.fields

export const CheckFinding = Schema.Struct({ ...findingFields, suggest: SuggestedCall })
export type CheckFinding = typeof CheckFinding.Type

export const CheckOutput = Schema.Struct({
  handle: Schema.String,
  range: Schema.String,
  rules: Schema.Array(RuleName).annotate({ description: "The rules that ran." }),
  findings: Schema.Array(CheckFinding).annotate({ description: "Rule findings, in frame order." }),
  assertions: Schema.Array(AssertionResult),
  pass: Schema.Boolean.annotate({
    description: "True when every assertion passed and no finding is an error. Warnings do not fail a check."
  })
}).annotate({ identifier: "CheckOutput" })

/**
 * A source's ground-truth `box.*` tracks laid out as a tracked region, so safe-area can run on
 * synthetic scenes without template matching. Sources without pixels or without the tracks get none.
 */
const groundTruthRegion = (source: Source, tracks: ReadonlyArray<Track>, range: FrameRange) => {
  const get = (name: string) => tracks.find((t) => t.name === name)
  const [x, y, w, h] = [get("box.x"), get("box.y"), get("box.w"), get("box.h")]
  if (!x || !y || !w || !h || source.timeline.size === null) return []
  const region: RegionTrack = {
    name: "box",
    method: "template",
    from: frameRef(range.rate, range.first),
    to: frameRef(range.rate, range.last),
    x,
    y,
    w,
    h,
    confidence: {
      name: "box.confidence",
      unit: "0..1",
      samples: x.samples.map((v) => (v === null ? null : 1))
    }
  }
  return [region]
}

export const check = define({
  name: "check",
  title: "Check rules and assertions",
  description:
    'Find problems and prove fixes with numbers: lint rules (duplicate or dropped frames, flicker, black frames, safe area, non-monotonic curves) and assertions such as "box.x <= 600 at 1s" or "@impact1 within #15..#25". Each finding names its frames and carries a ready-made kymo_frames call to look at it. Use it after a change to show the change worked; use frames to see a finding.',
  cost: "no images",
  examples: [
    { source: "synthetic:flicker?at=40" },
    { source: "synthetic:bounce?impact=20", assert: ["@impact1 within #18..#22", "box.x <= 600"] },
    { source: "clips/launch.mp4", rules: ["dropped-frames", "black-frames"], range: "0f..5s" }
  ],
  input: CheckInput,
  output: CheckOutput,
  readOnly: true,
  lines: "findings",
  run: Effect.fn("kymo.check")(function* (input: typeof CheckInput.Type) {
    const workspace = yield* Workspace
    const source = yield* workspace.open(input.source)
    const { timeline } = source
    const range = yield* analysisRange(timeline, input.range)
    const own = yield* Effect.forEach(timeline.tracks, (t) => source.track(t.name))
    const report = yield* runCheck({
      source,
      range,
      ...(input.rules === undefined ? {} : { rules: input.rules }),
      tracks: input.rules?.includes("non-monotonic") ? own : [],
      regions: groundTruthRegion(source, own, range)
    })
    const derived: { tracks: Array<Track>; markers: Array<Marker> } = { tracks: [], markers: [] }
    if (input.assert !== undefined && timeline.size !== null) {
      const stats = yield* scan(source, range)
      const cuts = detectCuts(stats)
      const motion = motionEnergy(stats, cuts)
      derived.tracks.push(motion.track)
      derived.markers.push(...cuts.cuts.map((c) => c.marker), ...motion.peaks.map((p) => p.marker))
    }
    const assertions =
      input.assert === undefined
        ? []
        : yield* runAssertions({
            source,
            assertions: input.assert,
            tracks: derived.tracks,
            markers: derived.markers
          })
    const findings = report.findings.map(({ suggest, ...f }) => ({
      ...f,
      suggest: {
        tool: "kymo_frames" as const,
        arguments: { source: timeline.handle, at: suggest.at, view: suggest.view },
        command: `kymo frames ${timeline.handle} --at ${suggest.at.join(" ")} --view ${suggest.view}`
      }
    }))
    return {
      handle: timeline.handle,
      range: range.spanText(range.first, range.last),
      rules: report.rules,
      findings,
      assertions,
      pass: assertions.every((a) => a.pass) && findings.every((f) => f.severity !== "error")
    }
  }, Effect.scoped)
})
