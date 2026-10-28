import { type FrameRef, InvalidInput } from "@kymo/core"
import { Result, Schema } from "effect"
import type { Cuts } from "./Cuts.ts"
import { shotEnergy } from "./Motion.ts"
import type { FrameRange } from "./Range.ts"
import type { Scan } from "./Scan.ts"
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

/** Collects distinct frame indices in priority order until the budget is spent. */
class Picks {
  readonly taken = new Set<number>()
  readonly range: FrameRange
  readonly budget: number

  constructor(range: FrameRange, budget: number) {
    this.range = range
    this.budget = Math.min(budget, range.count)
  }

  get full(): boolean {
    return this.taken.size >= this.budget
  }

  add(index: number): void {
    if (!this.full && index >= this.range.first && index <= this.range.last) this.taken.add(index)
  }

  /** Add `index`, or the nearest free frame to it (later first on ties). */
  addNear(index: number): void {
    for (let d = 0; d <= this.range.count && !this.full; d++) {
      for (const i of [index + d, index - d]) {
        if (i >= this.range.first && i <= this.range.last && !this.taken.has(i)) {
          this.taken.add(i)
          return
        }
      }
    }
  }

  refs(): ReadonlyArray<FrameRef> {
    return [...this.taken].sort((a, b) => a - b).map((i) => this.range.ref(i))
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
const cutIndices = (range: FrameRange, cuts: Cuts) =>
  cuts.cuts.filter((c) => c.marker.index >= range.first && c.marker.index <= range.last)

const sampleMotion = (scan: Scan, cuts: Cuts, picks: Picks): void => {
  const { range } = scan
  picks.add(range.first)
  picks.add(range.last)
  for (const c of [...cutIndices(range, cuts)].sort((a, b) => b.score - a.score)) picks.add(c.marker.index)
  const n = picks.budget - picks.taken.size
  if (n <= 0) return
  const energy = shotEnergy(scan, cuts)
  // A floor keeps still stretches from vanishing entirely.
  const floor = 0.1 * mean(energy) + 1e-9
  const cumulative: Array<number> = []
  let total = 0
  for (const e of energy) cumulative.push((total += e + floor))
  let k = 0
  for (let j = 0; j < n; j++) {
    const target = ((j + 0.5) / n) * total
    while (k < cumulative.length - 1 && cumulative[k]! < target) k++
    picks.addNear(range.first + k)
  }
}

const sampleCuts = (range: FrameRange, cuts: Cuts, picks: Picks): void => {
  picks.add(range.first)
  picks.add(range.last)
  const inRange = cutIndices(range, cuts)
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
}

/**
 * Choose at most `budget` frames, deterministically, sorted by index.
 * - `even`: evenly spaced, first and last included.
 * - `motion`: first, last and every cut, then the rest spread by cumulative motion energy.
 * - `cuts`: both sides of every cut, then their neighbours, then even fill.
 */
export const sample = (request: SampleRequest): ReadonlyArray<FrameRef> => {
  switch (request.strategy) {
    case "even": {
      const picks = new Picks(request.range, request.budget)
      fillEven(picks)
      return picks.refs()
    }
    case "motion": {
      const picks = new Picks(request.scan.range, request.budget)
      sampleMotion(request.scan, request.cuts, picks)
      return picks.refs()
    }
    case "cuts": {
      const picks = new Picks(request.range, request.budget)
      sampleCuts(request.range, request.cuts, picks)
      return picks.refs()
    }
  }
}
