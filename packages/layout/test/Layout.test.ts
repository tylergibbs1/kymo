import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import {
  type GridRequest,
  LABEL_FONT_PX,
  type PaginateRequest,
  type SheetPlan,
  type Target,
  customTarget,
  cursorOffset,
  decodeCursor,
  encodeCursor,
  highRes,
  paginate,
  planGrid,
  standard,
  targetBudget,
  visualTokens
} from "@kymo/layout"

const HD = { width: 1920, height: 1080 }
const LABEL = "08s10f #250".length

const plan = (req: Partial<GridRequest> = {}): SheetPlan => {
  const r = planGrid({ count: 12, frame: HD, target: highRes, labelChars: LABEL, ...req })
  if (Result.isFailure(r)) throw new Error(r.failure.message)
  return r.success
}

const pages = (req: Partial<PaginateRequest> & { readonly items: number }) => {
  const r = paginate({ frame: HD, target: standard, labelChars: LABEL, ...req })
  if (Result.isFailure(r)) throw new Error(r.failure.message)
  return r.success
}

const withinBudget = (p: SheetPlan, target: Target) => {
  const b = targetBudget(target)
  expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(b.maxEdge)
  expect(p.tokens).toBeLessThanOrEqual(b.maxTokens)
  expect(p.tokens).toBe(visualTokens(p.width, p.height))
}

/** Every cell's frame and label lie inside the sheet, and no two cells overlap. */
const wellFormed = (p: SheetPlan) => {
  for (const c of p.cells) {
    for (const r of [c.frame, c.label]) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(p.width)
      expect(r.y + r.height).toBeLessThanOrEqual(p.height)
    }
    expect(c.frame).toMatchObject(p.frame)
    // The label sits under the frame, never on it.
    expect(c.label.y).toBe(c.frame.y + c.frame.height)
    expect(c.label.height).toBeGreaterThanOrEqual(LABEL_FONT_PX)
  }
  for (const a of p.cells)
    for (const b of p.cells) {
      if (a === b) continue
      const apart =
        a.label.x + a.label.width <= b.label.x ||
        b.label.x + b.label.width <= a.label.x ||
        a.label.y + a.label.height <= b.frame.y ||
        b.label.y + b.label.height <= a.frame.y
      expect(apart).toBe(true)
    }
}

describe("visualTokens", () => {
  it("counts started 28 px tiles", () => {
    expect(visualTokens(28, 28)).toBe(1)
    expect(visualTokens(29, 28)).toBe(2)
    expect(visualTokens(1568, 784)).toBe(1568)
  })
})

describe("planGrid", () => {
  it("draws 12 HD frames at high-res as large as the budget allows", () => {
    const p = plan()
    withinBudget(p, highRes)
    wellFormed(p)
    expect(p.cells).toHaveLength(12)
    // At least the 4x3 edge-limited reference (≈636x358); the token budget may allow more.
    expect(p.frame.width).toBeGreaterThanOrEqual(630)
    expect(p.frame.width).toBeLessThanOrEqual(720)
    expect(Math.abs(p.frame.width / p.frame.height - 16 / 9)).toBeLessThan(0.01)
  })

  it("fits 12 HD frames inside the standard budget at about 380x214", () => {
    const p = plan({ target: standard })
    withinBudget(p, standard)
    wellFormed(p)
    expect(p.frame.width).toBeGreaterThanOrEqual(370)
    expect(p.frame.width).toBeLessThanOrEqual(400)
  })

  it("never upscales a small source", () => {
    const p = plan({ frame: { width: 160, height: 90 } })
    expect(p.frame).toEqual({ width: 160, height: 90 })
    wellFormed(p)
  })

  it("widens a cell to fit its label rather than shrinking the text", () => {
    const p = plan({ frame: { width: 64, height: 36 }, labelChars: "clip1@08s10f #250".length })
    for (const c of p.cells) expect(c.label.width).toBeGreaterThanOrEqual(17 * 18)
    wellFormed(p)
  })

  it("balances the last row", () => {
    for (const count of [5, 7, 10, 11]) {
      const p = plan({ count })
      const perRow = Array.from({ length: p.rows }, (_, r) => p.cells.filter((c) => c.row === r).length)
      expect(Math.max(...perRow) - Math.min(...perRow)).toBeLessThanOrEqual(1)
    }
  })

  it("fills fixed columns in order", () => {
    const p = plan({ count: 6, columns: 2 })
    expect(p.columns).toBe(2)
    expect(p.rows).toBe(3)
  })

  it("honours a custom target", () => {
    const t = customTarget({ maxEdge: 1000, maxTokens: 800 })
    if (Result.isFailure(t)) throw new Error(t.failure.message)
    const p = plan({ target: t.success })
    withinBudget(p, t.success)
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1000)
  })

  it("rejects out-of-range custom targets and counts", () => {
    expect(Result.isFailure(customTarget({ maxEdge: 10, maxTokens: 800 }))).toBe(true)
    expect(Result.isFailure(customTarget({ maxEdge: 1000.5, maxTokens: 800 }))).toBe(true)
    const r = planGrid({ count: 13, frame: HD, target: highRes, labelChars: LABEL })
    expect(Result.isFailure(r) && r.failure._tag).toBe("InvalidInput")
  })
})

describe("paginate", () => {
  it("splits a long list into balanced legible sheets with a cursor for the rest", () => {
    const first = pages({ items: 60 })
    expect(first.pages).toHaveLength(4)
    expect(first.pages.map((p) => p.count)).toEqual([12, 12, 12, 12])
    expect(first.next).toBeDefined()
    const rest = pages({ items: 60, cursor: first.next })
    expect(rest.pages.map((p) => p.offset)).toEqual([48])
    expect(rest.next).toBeUndefined()
  })

  it("balances sheet sizes instead of leaving a stub", () => {
    expect(pages({ items: 13 }).pages.map((p) => p.count)).toEqual([7, 6])
  })

  it("holds fewer frames per sheet rather than drawing them illegibly small", () => {
    const tiny = customTarget({ maxEdge: 800, maxTokens: 600 })
    if (Result.isFailure(tiny)) throw new Error(tiny.failure.message)
    const r = pages({ items: 12, target: tiny.success })
    expect(r.pages.length).toBeGreaterThan(1)
    for (const p of r.pages)
      expect(Math.max(p.plan.frame.width, p.plan.frame.height)).toBeGreaterThanOrEqual(320)
  })

  it("lays out pairs on one row", () => {
    const r = pages({ items: 6, cellsPerItem: 2 })
    for (const p of r.pages) expect(p.plan.columns).toBe(2)
    expect(r.pages.reduce((n, p) => n + p.count, 0)).toBe(6)
  })

  it("round-trips cursors and refuses foreign text", () => {
    for (const n of [0, 1, 48, 12345]) {
      const back = decodeCursor(encodeCursor(n))
      expect(Result.isSuccess(back) && cursorOffset(back.success)).toBe(n)
    }
    expect(Result.isFailure(decodeCursor("page2"))).toBe(true)
    const past = paginate({
      items: 5,
      frame: HD,
      target: standard,
      labelChars: LABEL,
      cursor: encodeCursor(9)
    })
    expect(Result.isFailure(past)).toBe(true)
  })
})
