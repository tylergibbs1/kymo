import {
  AssertionResult,
  Finding,
  type FrameRange,
  type RegionTrack,
  RuleName,
  type Severity,
  check as runCheck,
  detectCuts,
  frameRef,
  motionEnergy,
  runAssertions,
  scan
} from "@kymo/analysis"
import { FramesView, InvalidInput, type Marker, type Source, type Track } from "@kymo/core"
import { Workspace } from "@kymo/sources"
import { Effect, Schema } from "effect"
import { BoxText, Range, Source as SourceField } from "../Fields.ts"
import { analysisRange } from "../Frames.ts"
import { define, jsonLines, optionHint } from "../Operation.ts"
import { exampleBox, findBoxHint, measureBox, measureChange } from "../Region.ts"

export const CheckInput = Schema.Struct({
  source: SourceField,
  rules: Schema.optionalKey(
    Schema.Array(RuleName).check(Schema.isMinLength(1)).annotate({
      description:
        "Lint rules to run. Default without assert: every pixel rule (duplicate-frames, dropped-frames, flicker, black-frames), plus safe-area when there is a box (the box field, or the source's box.* tracks), plus non-monotonic when tracks is given. Default with assert: none, so the verdict is the assertions'. non-monotonic runs on request, over tracks."
    })
  ),
  assert: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1)))
      .check(Schema.isMinLength(1))
      .annotate({
        description:
          'Assertions over tracks and markers, e.g. "box.x <= 600 at 1s", "box.opacity >= 0.99 by 500ms", "box.change == 0 after 40f", "@impact1 within #15..#25". Tracks: the source\'s own; with box, box.x/.y/.w/.h/.opacity (the tracked subject) and box.change (the fraction of the box, fixed on screen, that visibly changed since the previous frame); and motion (whole-frame energy). Markers: the source\'s plus cut1.., peak1...'
      })
  ),
  range: Schema.optionalKey(Range),
  tracks: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1)))
      .check(Schema.isMinLength(1))
      .annotate({
        description:
          "Tracks non-monotonic checks, each expected to move one way: the source's own (probe lists them) and, with box, box.x, box.y, box.w, box.h and box.opacity. Default: with box, box.x and box.y (an axis that does not move is skipped); without, the source's own tracks."
      })
  ),
  box: Schema.optionalKey(
    BoxText.annotate({
      description:
        "A region to measure on footage, as it is at the first frame of the range: x,y,w,h in source pixels, e.g. 120,80,64,64 (same as track's box). It is tracked through the range; safe-area checks it, and assertions can use box.x, box.y, box.w, box.h and box.opacity, and box.change for the box where it is on screen."
    })
  ),
  safeMargin: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.5, exclusiveMaximum: true })).annotate({
      description: "Safe-area inset as a fraction of each edge: 0.05 action-safe (default), 0.1 title-safe."
    })
  )
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
  }),
  counts: Schema.Struct({ error: Schema.Int, warning: Schema.Int, info: Schema.Int }).annotate({
    description: "Findings by severity. pass can be true with warnings; read these too."
  }),
  label: Schema.String.annotate({
    description:
      'One line for people and agents, e.g. "Pass with 2 warnings, 0 errors, 0 info; 3 of 3 assertions passed."'
  })
}).annotate({ identifier: "CheckOutput" })

const invalid = (message: string, hint: string) => Effect.fail(new InvalidInput({ message, hint }))

/**
 * The tracks non-monotonic reads: those named in `tracks`, else a measured box's x and y (an axis
 * that does not move has no motion to reverse in), else the source's own. A measured box's tracks
 * replace the source's own tracks of the same name. None unless the rule runs.
 */
const monotonicTracks = (
  input: typeof CheckInput.Type,
  rules: ReadonlyArray<RuleName> | undefined,
  own: ReadonlyArray<Track>,
  measured: RegionTrack | undefined,
  boxHint: string
): Effect.Effect<ReadonlyArray<Track>, InvalidInput> => {
  const runs = rules === undefined ? input.tracks !== undefined : rules.includes("non-monotonic")
  if (!runs)
    return input.tracks === undefined
      ? Effect.succeed([])
      : invalid(
          "tracks is only read by the non-monotonic rule, which this check does not run.",
          `Add the rule, e.g. ${optionHint(CheckInput, "rules", ["non-monotonic"])}, or drop tracks.`
        )
  const fromBox =
    measured === undefined ? [] : [measured.x, measured.y, measured.w, measured.h, measured.opacity]
  const available = [...own.filter((t) => !fromBox.some((b) => b.name === t.name)), ...fromBox]
  const viaBox = `${boxHint}, and non-monotonic checks box.x and box.y`
  if (input.tracks !== undefined) {
    const unknown = input.tracks.filter((name) => !available.some((t) => t.name === name))
    if (unknown.length > 0)
      return invalid(
        `No track named ${unknown.join(", ")}.`,
        available.length === 0
          ? `This source has no tracks. ${viaBox}.`
          : `Name tracks from: ${available.map((t) => t.name).join(", ")}${measured === undefined ? "; box.x, box.y, box.w, box.h and box.opacity need box" : ""}.`
      )
    return Effect.succeed(input.tracks.map((name) => available.find((t) => t.name === name)!))
  }
  if (measured !== undefined) return Effect.succeed([measured.x, measured.y])
  if (own.length === 0)
    return invalid(
      "non-monotonic needs something that should move one way, and this source has no tracks.",
      `${viaBox}.`
    )
  return Effect.succeed(own)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 || word === "info" ? "" : "s"}`

/** pass, counts and label from the same findings and assertions, so they always agree. */
const verdict = (
  findings: ReadonlyArray<{ readonly severity: Severity }>,
  assertions: ReadonlyArray<AssertionResult>
) => {
  const counts = { error: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.severity]++
  const passed = assertions.filter((a) => a.pass).length
  const pass = counts.error === 0 && passed === assertions.length
  const severities = `${plural(counts.warning, "warning")}, ${plural(counts.error, "error")}, ${plural(counts.info, "info")}`
  const asserted =
    assertions.length === 0 ? "no assertions" : `${passed} of ${assertions.length} assertions passed`
  const head = pass ? (counts.warning + counts.info > 0 ? "Pass with " : "Pass: ") : "Fail: "
  return { pass, counts, label: `${head}${severities}; ${asserted}.` }
}

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
    },
    opacity: get("box.opacity") ?? {
      name: "box.opacity",
      unit: "ratio",
      samples: x.samples.map(() => null)
    },
    lost: []
  }
  return [region]
}

export const check = define({
  name: "check",
  title: "Check rules and assertions",
  description:
    'Find problems and prove fixes with numbers: lint rules (duplicate or dropped frames, flicker, black frames, safe area, non-monotonic curves) and assertions such as "box.x <= 600 at 1s" or "@impact1 within #15..#25". Each finding names its frames and carries a ready-made kymo_frames call to look at it. On footage, pass box (the region at the first frame of the range) to check safe-area and assert on box.x/.y/.w/.h/.opacity, or box.change for the region where it is on screen. Use it after a change to show the change worked; use frames to see a finding, and track to read values.',
  cost: "no images",
  examples: [
    { source: "synthetic:flicker?at=40" },
    { source: "synthetic:bounce?impact=20", assert: ["@impact1 within #18..#22", "box.x <= 600"] },
    { source: "clips/launch.mp4", rules: ["dropped-frames", "black-frames"], range: "0f..5s" },
    {
      source: "clips/launch.mp4",
      box: "120,80,64,64",
      rules: ["safe-area"],
      safeMargin: 0.1,
      assert: ["box.x <= 554 at 2s"]
    }
  ],
  input: CheckInput,
  output: CheckOutput,
  readOnly: true,
  passed: (output) => output.pass,
  lines: jsonLines(CheckOutput, "findings"),
  run: Effect.fn("kymo.check")(function* (input: typeof CheckInput.Type) {
    const workspace = yield* Workspace
    const source = yield* workspace.open(input.source)
    const { timeline } = source
    const range = yield* analysisRange(timeline, input.range)
    const own = yield* Effect.forEach(timeline.tracks, (t) => source.track(t.name))
    const measured = input.box === undefined ? undefined : yield* measureBox(source, range, input.box)
    const regions = measured === undefined ? groundTruthRegion(source, own, range) : [measured]
    const boxHint =
      timeline.size === null
        ? "Pass a source with pixels and its box"
        : `Pass the box as it is at the first frame of the range, e.g. ${optionHint(CheckInput, "box", exampleBox(timeline.size))}; ${findBoxHint(source, range)}`
    if (input.rules?.includes("safe-area") && regions.length === 0 && timeline.size !== null)
      return yield* invalid(
        `safe-area needs the box of what must stay inside the frame, and ${timeline.handle} has no box.* tracks.`,
        `${boxHint}.`
      )
    // Assertions alone ask one question; running every default rule too would bury its answer.
    const rules = input.rules ?? (input.assert === undefined ? undefined : [])
    const report = yield* runCheck({
      source,
      range,
      ...(rules === undefined ? {} : { rules }),
      ...(input.safeMargin === undefined ? {} : { safeMargin: input.safeMargin }),
      tracks: yield* monotonicTracks(input, rules, own, measured, boxHint),
      regions
    })
    const derived: { tracks: Array<Track>; markers: Array<Marker> } = {
      tracks:
        measured === undefined
          ? []
          : [measured.x, measured.y, measured.w, measured.h, measured.confidence, measured.opacity],
      markers: []
    }
    if (input.box !== undefined && input.assert?.some((a) => a.includes("box.change")))
      derived.tracks.push((yield* measureChange(source, range, input.box)).track)
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
      ...verdict(findings, assertions)
    }
  }, Effect.scoped)
})
