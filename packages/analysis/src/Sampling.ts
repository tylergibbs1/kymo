import { type FrameRef, InvalidInput } from "@kymo/core"
import { Result, Schema } from "effect"
import type { Cut, Cuts } from "./Cuts.ts"
import { motionEnergy } from "./Motion.ts"
import { maxAbsDiff } from "./Pixels.ts"
import type { FrameRange } from "./Range.ts"
import type { Scan } from "./Scan.ts"
import { signals } from "./Signals.ts"
import { mean } from "./Stats.ts"

export const SampleStrategy = Schema.Literals(["even", "motion", "cuts"])
export type SampleStrategy = typeof SampleStrategy.Type

/** How many frames a sample may return: a positive integer. */
export const Budget = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("Budget"))
export type Budget = typeof Budget.Type

export const parseBudget = (n: number): Result.Result<Budget, InvalidInput> =>
  Number.isInteger(n) && n > 0
    ? Result.succeed(Budget.make(n))
    : Result.fail(
        new InvalidInput({
          message: `A frame budget is a positive whole number; got ${n}.`,
          hint: "Ask for e.g. 12 frames."
        })
      )

/** Each strategy states exactly what it needs, so a motion sample cannot be asked for without a scan. */
export type SampleRequest =
  | { readonly strategy: "even"; readonly range: FrameRange; readonly budget: Budget }
  | { readonly strategy: "motion"; readonly scan: Scan; readonly cuts: Cuts; readonly budget: Budget }
  | { readonly strategy: "cuts"; readonly range: FrameRange; readonly cuts: Cuts; readonly budget: Budget }

export interface Sample {
  /** The chosen frames, sorted by index. */
  readonly frames: ReadonlyArray<FrameRef>
  /** Cuts in the range that no chosen frame shows, in time order: the budget ran out before them. */
  readonly omittedCuts: ReadonlyArray<Cut>
}

/** Cuts take at most this share of a motion sample's budget, so motion always has room. */
const CUT_SHARE = 0.5
/** The strongest motion peaks get up to this share of the budget before the rest is spread. */
const PEAK_SHARE = 0.25
/** Two chosen frames are at least this share of an even spacing apart, where the clip allows. */
const SPACING = 0.5
/** Spread by changed area, capped at this quantile of the clip's changes, so one flash cannot take the budget. */
const WEIGHT_CAP_QUANTILE = 0.9

interface PickRules {
  /** Do frames `a` and `b` show the same picture? */
  readonly same?: (a: number, b: number) => boolean
  /** Nearest allowed distance between two chosen frames. */
  readonly gap?: number
  /** How far `addNear` looks from its target. */
  readonly radius?: number
}

/** Collects distinct frame indices in priority order until the budget is spent. */
class Picks {
  readonly taken = new Set<number>()
  readonly range: FrameRange
  readonly budget: number
  readonly rules: PickRules

  constructor(range: FrameRange, budget: number, rules: PickRules = {}) {
    this.range = range
    this.budget = Math.min(budget, range.count)
    this.rules = rules
  }

  get full(): boolean {
    return this.taken.size >= this.budget
  }

  /** A chosen frame showing the same picture as `index`, if any. */
  shownAs(index: number): number | undefined {
    if (this.taken.has(index)) return index
    const { same } = this.rules
    if (same) for (const t of this.taken) if (same(t, index)) return t
    return undefined
  }

  private inRange(i: number): boolean {
    return i >= this.range.first && i <= this.range.last
  }

  private spaced(i: number): boolean {
    const gap = this.rules.gap ?? 1
    for (const t of this.taken) if (Math.abs(t - i) < gap) return false
    return true
  }

  /** Add `index` unless the budget is spent or its picture is already shown. */
  add(index: number): void {
    if (!this.full && this.inRange(index) && this.shownAs(index) === undefined) this.taken.add(index)
  }

  /**
   * Add the nearest frame to `index` (later first on ties) that shows a new picture, keeping the gap to
   * chosen frames if any frame within reach can.
   */
  addNear(index: number): void {
    const radius = this.rules.radius ?? this.range.count
    for (const spaced of [true, false]) {
      for (let d = 0; d <= radius && !this.full; d++) {
        for (const i of [index + d, index - d]) {
          if (this.inRange(i) && (!spaced || this.spaced(i)) && this.shownAs(i) === undefined) {
            this.taken.add(i)
            return
          }
        }
      }
    }
  }

  /** Cuts whose new picture is not shown: no chosen frame from the first mixed one to the first fully new one. */
  omitted(cuts: ReadonlyArray<Cut>): ReadonlyArray<Cut> {
    const shows = (c: Cut) => {
      for (let i = c.incoming.index; i < c.to.index; i++) if (this.taken.has(i)) return true
      return this.shownAs(c.to.index) !== undefined
    }
    return cuts.filter((c) => !shows(c))
  }

  sample(cuts: ReadonlyArray<Cut>): Sample {
    return {
      frames: [...this.taken].sort((a, b) => a - b).map((i) => this.range.ref(i)),
      omittedCuts: this.omitted(cuts)
    }
  }
}

const fillEven = (picks: Picks): void => {
  const { first, count } = picks.range
  const n = picks.budget - picks.taken.size
  if (n <= 0) return
  for (let j = 0; j < n; j++) {
    picks.addNear(
      n === 1 ? first + Math.floor((count - 1) / 2) : first + Math.round((j * (count - 1)) / (n - 1))
    )
  }
}

/** Cuts whose marker falls inside the range, in time order. */
const cutsIn = (range: FrameRange, cuts: Cuts) =>
  cuts.cuts.filter((c) => c.marker.index >= range.first && c.marker.index <= range.last)

/** How much changed at each scan position, as a share of the picture; 0 across cuts; capped. */
const changeWeights = (scan: Scan, changed: ReadonlyArray<number | null>, cuts: ReadonlyArray<Cut>) => {
  const first = scan.range.first
  const weights = changed.map((c) => c ?? 0)
  for (const c of cuts) for (let i = c.from.index + 1; i <= c.to.index; i++) weights[i - first] = 0
  const positive = weights.filter((w) => w > 0).sort((a, b) => a - b)
  const cap = positive[Math.floor(WEIGHT_CAP_QUANTILE * (positive.length - 1))] ?? 0
  return weights.map((w) => Math.min(w, cap))
}

const sampleMotion = (scan: Scan, cuts: Cuts, budget: Budget): Sample => {
  const { range, frames } = scan
  const n = Math.min(budget, range.count)
  const thumb = (i: number) => frames[i - range.first]!.thumb
  const clip = signals(scan)
  const picks = new Picks(range, budget, {
    // No part of the picture differs by more than this clip's noise: one of them is enough. Per pixel of
    // the thumbnail, not on average, so a small element moving still makes a new picture.
    same: (a, b) => maxAbsDiff(thumb(a), thumb(b)) <= clip.noiseLevel,
    gap: Math.max(1, Math.floor((SPACING * range.count) / n)),
    radius: Math.max(1, Math.ceil(range.count / n))
  })
  const inRange = cutsIn(range, cuts)
  picks.add(range.first)
  picks.add(range.last)
  // Strongest cuts first, each shown by its first fully new frame, within their share.
  const cutRoom = picks.taken.size + Math.floor(CUT_SHARE * n)
  for (const c of [...inRange].sort((a, b) => b.score - a.score)) {
    if (picks.taken.size >= cutRoom) break
    picks.add(c.to.index)
  }
  const peakRoom = picks.taken.size + Math.ceil(PEAK_SHARE * n)
  for (const p of motionEnergy(scan, cuts).peaks) {
    if (picks.taken.size >= peakRoom) break
    picks.addNear(p.marker.index)
  }
  // The rest spread by how much of the picture changes, with a floor so still stretches do not vanish.
  const weights = changeWeights(scan, clip.changed, inRange)
  const floor = 0.1 * mean(weights) + 1e-9
  const cumulative: Array<number> = []
  let total = 0
  for (const w of weights) cumulative.push((total += w + floor))
  const rest = picks.budget - picks.taken.size
  let k = 0
  for (let j = 0; j < rest; j++) {
    const target = ((j + 0.5) / rest) * total
    while (k < cumulative.length - 1 && cumulative[k]! < target) k++
    picks.addNear(range.first + k)
  }
  return picks.sample(inRange)
}

const sampleCuts = (range: FrameRange, cuts: Cuts, budget: Budget): Sample => {
  const picks = new Picks(range, budget)
  picks.add(range.first)
  picks.add(range.last)
  const inRange = cutsIn(range, cuts)
  for (const c of inRange) {
    picks.add(c.from.index)
    picks.add(c.marker.index)
    picks.add(c.to.index)
  }
  for (const c of inRange) {
    picks.add(c.from.index - 1)
    picks.add(c.to.index + 1)
  }
  fillEven(picks)
  return picks.sample(inRange)
}

/**
 * Choose at most `budget` frames, deterministically, sorted by index, and say which cuts did not fit.
 * - `even`: evenly spaced, first and last included.
 * - `motion`: first and last, the strongest cuts (up to half the budget), the strongest motion peaks,
 *   then the rest spread by how much of the picture changes. Frames showing a picture already chosen
 *   (black, a held frame) are skipped, and chosen frames keep apart.
 * - `cuts`: both sides of every cut, then their neighbours, then even fill.
 */
export const sample = (request: SampleRequest): Sample => {
  switch (request.strategy) {
    case "even": {
      const picks = new Picks(request.range, request.budget)
      fillEven(picks)
      return picks.sample([])
    }
    case "motion":
      return sampleMotion(request.scan, request.cuts, request.budget)
    case "cuts":
      return sampleCuts(request.range, request.cuts, request.budget)
  }
}
