import { InvalidInput } from "@kymo/core"
import { Result } from "effect"
import { type Target, targetBudget } from "./Target.ts"
import { visualTokens } from "./Tokens.ts"

/** Most frames one sheet holds. */
export const MAX_PER_SHEET = 12
/** Space between cells, in pixels. */
export const GUTTER_PX = 8
/** Label text size at final (sent) size. Never smaller: an unreadable label is worse than none. */
export const LABEL_FONT_PX = 28
/** Advance of one monospace label character at `LABEL_FONT_PX`, rounded up. */
export const LABEL_CHAR_PX = 18
/** Space either side of label text. */
export const LABEL_PAD_PX = 8
/** Height of the bar under each frame that carries its label. Labels never cover frame pixels. */
export const LABEL_BAR_PX = 40
/** Height of the bar under each filmstrip row: tick marks plus the addresses under them. */
export const RULER_BAR_PX = 56
/**
 * Smallest long edge a frame is drawn at before a sheet holds fewer frames instead.
 * Sources smaller than this are drawn at their own size.
 */
export const MIN_CELL_EDGE = 320

/** Width a label of this many characters needs. */
export const labelWidth = (chars: number): number => chars * LABEL_CHAR_PX + 2 * LABEL_PAD_PX

/** What sits under each row: one label per frame, or a timecode ruler. */
export type Bar = "label" | "ruler"

const barHeight = (bar: Bar): number => (bar === "label" ? LABEL_BAR_PX : RULER_BAR_PX)

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface Cell {
  /** Where the frame's pixels go. Exactly `SheetPlan.frame` in size. */
  readonly frame: Rect
  /** The bar under the frame for its label (or its part of the row's ruler). */
  readonly label: Rect
  readonly row: number
  readonly column: number
}

/** A fully decided sheet: views draw exactly this, they do not size anything themselves. */
export interface SheetPlan {
  readonly width: number
  readonly height: number
  /** `visualTokens(width, height)`. */
  readonly tokens: number
  readonly rows: number
  readonly columns: number
  /** Drawn size of every frame; never larger than the source frame. */
  readonly frame: Size
  readonly bar: Bar
  /** One per frame, in reading order. */
  readonly cells: ReadonlyArray<Cell>
}

export interface GridRequest {
  /** Frames on the sheet, 1 to `MAX_PER_SHEET`. */
  readonly count: number
  /** Source frame size in pixels. */
  readonly frame: Size
  readonly target: Target
  /** Characters in the longest label, so its bar is wide enough at full size. */
  readonly labelChars: number
  /** Fix the column count, filling rows in order (e.g. 2 for side-by-side pairs). */
  readonly columns?: number
  readonly bar?: Bar
}

const invalid = (message: string, hint: string) => new InvalidInput({ message, hint })

const isPositiveInt = (n: number) => Number.isInteger(n) && n > 0

const validate = (req: GridRequest): InvalidInput | undefined => {
  if (!isPositiveInt(req.count) || req.count > MAX_PER_SHEET)
    return invalid(
      `A sheet holds 1 to ${MAX_PER_SHEET} frames, not ${req.count}.`,
      "Paginate longer lists with `paginate`."
    )
  if (!isPositiveInt(req.frame.width) || !isPositiveInt(req.frame.height))
    return invalid(
      `Frame size ${req.frame.width}x${req.frame.height} is not a positive integer size.`,
      "Sources without pixels (telemetry) have no frames to lay out; plot their tracks instead."
    )
  if (!isPositiveInt(req.labelChars))
    return invalid(
      `Label length ${req.labelChars} is not a positive integer.`,
      "Pass the longest label's length."
    )
  if (req.columns !== undefined && (!isPositiveInt(req.columns) || req.columns > req.count))
    return invalid(`${req.columns} columns does not fit ${req.count} frames.`, "Use 1 to count columns.")
  return undefined
}

/** Frames per row, top to bottom. Balanced (rows differ by at most one) unless columns are fixed. */
const rowCounts = (count: number, rows: number, fixedColumns: number | undefined): Array<number> => {
  if (fixedColumns !== undefined)
    return Array.from({ length: rows }, (_, r) => Math.min(fixedColumns, count - r * fixedColumns))
  const base = Math.floor(count / rows)
  const extra = count % rows
  return Array.from({ length: rows }, (_, r) => base + (r < extra ? 1 : 0))
}

interface Shape {
  readonly rows: number
  readonly columns: number
  readonly counts: ReadonlyArray<number>
}

const shapes = (count: number, fixedColumns: number | undefined): Array<Shape> => {
  if (fixedColumns !== undefined) {
    const rows = Math.ceil(count / fixedColumns)
    return [{ rows, columns: fixedColumns, counts: rowCounts(count, rows, fixedColumns) }]
  }
  const out: Array<Shape> = []
  for (let rows = 1; rows <= count; rows++) {
    const columns = Math.ceil(count / rows)
    // Several row counts can give the same column count; only the fewest rows is a distinct shape.
    if (out.some((s) => s.columns === columns)) continue
    if (Math.ceil(count / columns) !== rows) continue
    out.push({ rows, columns, counts: rowCounts(count, rows, undefined) })
  }
  return out
}

interface Sized {
  readonly shape: Shape
  readonly frame: Size
  readonly slotWidth: number
  readonly width: number
  readonly height: number
  readonly tokens: number
}

const frameAt = (source: Size, width: number): Size => ({
  width,
  height: Math.min(source.height, Math.max(1, Math.round((width * source.height) / source.width)))
})

const size = (shape: Shape, source: Size, frameWidth: number, labelW: number, bar: number): Sized => {
  const frame = frameAt(source, frameWidth)
  const slotWidth = Math.max(frame.width, labelW)
  const width = shape.columns * slotWidth + (shape.columns - 1) * GUTTER_PX
  const height = shape.rows * (frame.height + bar) + (shape.rows - 1) * GUTTER_PX
  return { shape, frame, slotWidth, width, height, tokens: visualTokens(width, height) }
}

/** The largest frame this shape can draw inside the budget, or undefined if even 1 px does not fit. */
const largest = (
  shape: Shape,
  source: Size,
  labelW: number,
  bar: number,
  limit: { readonly maxEdge: number; readonly maxTokens: number }
): Sized | undefined => {
  const fits = (s: Sized) => Math.max(s.width, s.height) <= limit.maxEdge && s.tokens <= limit.maxTokens
  if (!fits(size(shape, source, 1, labelW, bar))) return undefined
  // Every dimension is non-decreasing in frame width, so the feasible widths are a prefix.
  let lo = 1
  let hi = source.width
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(size(shape, source, mid, labelW, bar))) lo = mid
    else hi = mid - 1
  }
  return size(shape, source, lo, labelW, bar)
}

const better = (a: Sized, b: Sized): boolean => {
  const areaA = a.frame.width * a.frame.height
  const areaB = b.frame.width * b.frame.height
  if (areaA !== areaB) return areaA > areaB
  if (a.tokens !== b.tokens) return a.tokens < b.tokens
  return a.shape.columns > b.shape.columns
}

const place = (s: Sized, bar: Bar): SheetPlan => {
  const barH = barHeight(bar)
  const cells: Array<Cell> = []
  s.shape.counts.forEach((inRow, row) => {
    const rowWidth = inRow * s.slotWidth + (inRow - 1) * GUTTER_PX
    const left = Math.floor((s.width - rowWidth) / 2)
    const top = row * (s.frame.height + barH + GUTTER_PX)
    for (let column = 0; column < inRow; column++) {
      const slotX = left + column * (s.slotWidth + GUTTER_PX)
      cells.push({
        row,
        column,
        frame: {
          x: slotX + Math.floor((s.slotWidth - s.frame.width) / 2),
          y: top,
          width: s.frame.width,
          height: s.frame.height
        },
        label: { x: slotX, y: top + s.frame.height, width: s.slotWidth, height: barH }
      })
    }
  })
  return {
    width: s.width,
    height: s.height,
    tokens: s.tokens,
    rows: s.shape.rows,
    columns: s.shape.columns,
    frame: s.frame,
    bar,
    cells
  }
}

/**
 * Lay out `count` frames so each is drawn as large as the target allows (long edge and
 * token budget), never larger than the source, with a full-size label bar under each.
 */
export const planGrid = (req: GridRequest): Result.Result<SheetPlan, InvalidInput> => {
  const bad = validate(req)
  if (bad) return Result.fail(bad)
  const bar = req.bar ?? "label"
  const limit = targetBudget(req.target)
  let best: Sized | undefined
  for (const shape of shapes(req.count, req.columns)) {
    const s = largest(shape, req.frame, labelWidth(req.labelChars), barHeight(bar), limit)
    if (s && (!best || better(s, best))) best = s
  }
  if (!best)
    return Result.fail(
      invalid(
        `${req.count} frames with ${req.labelChars}-character labels do not fit in ${limit.maxEdge} px / ${limit.maxTokens} tokens.`,
        "Use fewer frames per sheet, a shorter handle, or a larger target."
      )
    )
  return Result.succeed(place(best, bar))
}

/** True when the plan draws frames at least as large as legibility requires for this source. */
export const isLegible = (plan: SheetPlan, source: Size): boolean =>
  Math.max(plan.frame.width, plan.frame.height) >=
  Math.min(MIN_CELL_EDGE, Math.max(source.width, source.height))
