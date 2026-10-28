import { describe, expect, it } from "vitest"
import { cadences } from "../src/Cadence.ts"

const flags = (length: number, on: ReadonlyArray<number>) => Array.from({ length }, (_, k) => on.includes(k))

describe("cadences", () => {
  it("takes in patchy stretches of a cadence the clip has already shown, not lone events", () => {
    // Every 5th frame repeats from 200 to 400. Earlier, where the repeats are harder to see, only some
    // show (33, 38, 43, 53, 68); 128 is a lone repeat.
    const steady = Array.from({ length: 41 }, (_, n) => 200 + 5 * n)
    const isEvent = flags(420, [33, 38, 43, 53, 68, 128, ...steady])
    const found = cadences(
      isEvent,
      isEvent.map((_, k) => k >= 20),
      24
    )
    expect(found).toHaveLength(1)
    expect(found[0]!.period).toBe(5)
    expect(found[0]!.events).toEqual([33, 38, 43, 53, 68, ...steady])
  })
})
