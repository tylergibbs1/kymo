import { InvalidInput, type KymoError, type Source, type Track } from "@kymo/core"
import { Effect, Schema } from "effect"
import { detectCuts } from "./Cuts.ts"
import { Finding, RULES, RuleName } from "./Finding.ts"
import { type PixelInput, blackFrames, droppedFrames, duplicateFrames, flicker } from "./PixelRules.ts"
import type { FrameRange } from "./Range.ts"
import { scan } from "./Scan.ts"
import type { RegionTrack } from "./Tracker.ts"
import { nonMonotonic, safeArea } from "./TrackRules.ts"

export const CheckReport = Schema.Struct({
  /** The rules that ran. */
  rules: Schema.Array(RuleName),
  /** In frame order. */
  findings: Schema.Array(Finding)
})
export type CheckReport = typeof CheckReport.Type

export interface CheckInput {
  readonly source: Source
  readonly range: FrameRange
  /** Rules to run (see `parseRules`). Default: every rule the inputs allow. */
  readonly rules?: ReadonlyArray<RuleName>
  /** Tracks expected to move one way only, for `non-monotonic`. */
  readonly tracks?: ReadonlyArray<Track>
  /** Tracked regions, for `safe-area`. */
  readonly regions?: ReadonlyArray<RegionTrack>
  /** Safe-area margin as a fraction of each edge, 0 ≤ m < 0.5. Default 0.05 (action-safe). */
  readonly safeMargin?: number
}

const PIXEL_RULES = {
  "duplicate-frames": duplicateFrames,
  "dropped-frames": droppedFrames,
  flicker,
  "black-frames": blackFrames
} as const satisfies Partial<Record<RuleName, (input: PixelInput) => ReadonlyArray<Finding>>>
type PixelRule = keyof typeof PIXEL_RULES
const isPixelRule = (r: RuleName): r is PixelRule => r in PIXEL_RULES

const invalid = (message: string, hint: string) => Effect.fail(new InvalidInput({ message, hint }))

/** Run lint rules over a range. Pixel rules share one decode pass. */
export const check = (input: CheckInput): Effect.Effect<CheckReport, KymoError> =>
  Effect.gen(function* () {
    const { source, range } = input
    const size = source.timeline.size
    const regions = input.regions ?? []
    const tracks = input.tracks ?? []
    const margin = input.safeMargin ?? 0.05
    if (!(margin >= 0 && margin < 0.5)) {
      return yield* invalid(
        `A safe-area margin is a fraction of the frame below 0.5; got ${margin}.`,
        "Use 0.05 for action-safe or 0.1 for title-safe."
      )
    }
    const rules =
      input.rules ??
      RULES.filter((r) =>
        isPixelRule(r)
          ? size !== null
          : r === "safe-area"
            ? size !== null && regions.length > 0
            : tracks.length > 0
      )
    const pixelRules = rules.filter(isPixelRule)
    if (pixelRules.length > 0 && size === null) {
      return yield* invalid(
        `${pixelRules.join(", ")} read pixels, and ${source.timeline.handle} has none.`,
        "Run safe-area or non-monotonic on its tracks instead, e.g. rules=non-monotonic."
      )
    }
    const findings: Array<Finding> = []
    if (pixelRules.length > 0) {
      const s = yield* scan(source, range)
      const pixels: PixelInput = { scan: s, cuts: detectCuts(s) }
      for (const r of pixelRules) findings.push(...PIXEL_RULES[r](pixels))
    }
    if (rules.includes("safe-area")) {
      if (size === null || regions.length === 0) {
        return yield* invalid(
          "safe-area needs a tracked region on a source with pixels.",
          "Track one first, e.g. track box=120,80,64,64, then check rules=safe-area with that region."
        )
      }
      findings.push(...safeArea(range, size, margin, regions))
    }
    if (rules.includes("non-monotonic")) {
      if (tracks.length === 0) {
        return yield* invalid(
          "non-monotonic needs the tracks that should move one way.",
          "Name them, e.g. tracks=box.x,#hero.opacity."
        )
      }
      findings.push(...nonMonotonic(range, tracks))
    }
    findings.sort((a, b) => a.index - b.index || RULES.indexOf(a.rule) - RULES.indexOf(b.rule))
    return { rules: [...rules], findings }
  })
