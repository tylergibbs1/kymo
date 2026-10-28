import { InvalidInput } from "@kymo/core"
import { Result, Schema } from "effect"
import { type GridRequest, MAX_PER_SHEET, type SheetPlan, isLegible, planGrid } from "./Grid.ts"

/** Sheets one call returns unless the caller asks for a different number. */
export const DEFAULT_MAX_SHEETS = 4

/**
 * Where the next call picks up. Opaque to callers, deterministic for the same request:
 * it encodes the offset of the first item not yet drawn.
 */
export const Cursor = Schema.String.check(Schema.isPattern(/^s[0-9a-z]+$/)).pipe(Schema.brand("Cursor"))
export type Cursor = typeof Cursor.Type

export const encodeCursor = (offset: number): Cursor => Cursor.make(`s${offset.toString(36)}`)

const decodeCursorText = Schema.decodeUnknownResult(Cursor)

/** Validate cursor text from the outside world. */
export const decodeCursor = (text: string): Result.Result<Cursor, InvalidInput> =>
  Result.mapError(
    decodeCursorText(text),
    () =>
      new InvalidInput({
        message: `"${text}" is not a cursor from a previous result.`,
        hint: "Pass the `next` value of the previous call unchanged, or omit it to start at the beginning."
      })
  )

export const cursorOffset = (cursor: Cursor): number => parseInt(cursor.slice(1), 36)

export interface Page {
  /** Index of the page's first item in the full list. */
  readonly offset: number
  /** Items on this page. */
  readonly count: number
  readonly plan: SheetPlan
}

export interface Pages {
  readonly pages: ReadonlyArray<Page>
  /** Set when items remain after these pages. */
  readonly next: Cursor | undefined
}

export interface PaginateRequest extends Omit<GridRequest, "count" | "columns"> {
  /** Items to lay out (frames, or pairs of frames). */
  readonly items: number
  /** Cells each item takes, side by side on one row (2 for A|B pairs). Default 1. */
  readonly cellsPerItem?: number
  readonly cursor?: Cursor | undefined
  readonly maxSheets?: number | undefined
}

const gridFor = (req: PaginateRequest, items: number): GridRequest => {
  const per = req.cellsPerItem ?? 1
  const base = { frame: req.frame, target: req.target, labelChars: req.labelChars, count: items * per }
  const withBar = req.bar === undefined ? base : { ...base, bar: req.bar }
  return per === 1 ? withBar : { ...withBar, columns: per }
}

/** Most items one sheet holds while frames stay legible; at least one. */
export const sheetCapacity = (req: PaginateRequest): Result.Result<number, InvalidInput> => {
  const per = req.cellsPerItem ?? 1
  const most = Math.floor(MAX_PER_SHEET / per)
  if (!Number.isInteger(per) || per < 1 || most < 1)
    return Result.fail(
      new InvalidInput({
        message: `${per} cells per item does not fit a sheet of ${MAX_PER_SHEET}.`,
        hint: `Use 1 to ${MAX_PER_SHEET} cells per item.`
      })
    )
  for (let n = most; n > 1; n--) {
    const plan = planGrid(gridFor(req, n))
    if (Result.isSuccess(plan) && isLegible(plan.success, req.frame)) return Result.succeed(n)
  }
  return Result.map(planGrid(gridFor(req, 1)), () => 1)
}

/**
 * Split a list into sheets of balanced size, each planned, starting at the cursor.
 * Returns at most `maxSheets` (default 4) and a cursor for the rest.
 */
export const paginate = (req: PaginateRequest): Result.Result<Pages, InvalidInput> => {
  const maxSheets = req.maxSheets ?? DEFAULT_MAX_SHEETS
  const offset = req.cursor === undefined ? 0 : cursorOffset(req.cursor)
  if (!Number.isInteger(req.items) || req.items < 1)
    return Result.fail(
      new InvalidInput({
        message: `Nothing to lay out (${req.items} items).`,
        hint: "Pass at least one frame."
      })
    )
  if (!Number.isInteger(maxSheets) || maxSheets < 1)
    return Result.fail(
      new InvalidInput({
        message: `maxSheets must be a positive integer, not ${maxSheets}.`,
        hint: `Omit it for ${DEFAULT_MAX_SHEETS}.`
      })
    )
  if (offset >= req.items)
    return Result.fail(
      new InvalidInput({
        message: `The cursor points past the end of this ${req.items}-item list.`,
        hint: "Cursors are only valid for the request that returned them."
      })
    )
  return Result.flatMap(sheetCapacity(req), (capacity) => {
    const remaining = req.items - offset
    const sheets = Math.ceil(remaining / capacity)
    const base = Math.floor(remaining / sheets)
    const extra = remaining % sheets
    const pages: Array<Page> = []
    let at = offset
    for (let i = 0; i < Math.min(sheets, maxSheets); i++) {
      const count = base + (i < extra ? 1 : 0)
      const plan = planGrid(gridFor(req, count))
      if (Result.isFailure(plan)) return Result.fail(plan.failure)
      pages.push({ offset: at, count, plan: plan.success })
      at += count
    }
    return Result.succeed({ pages, next: at < req.items ? encodeCursor(at) : undefined })
  })
}
