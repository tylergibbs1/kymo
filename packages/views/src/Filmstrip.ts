import {
  Address,
  FRAME_CAP,
  type FrameIndex,
  InvalidInput,
  type KymoError,
  type Source,
  type Timeline,
  frameIndex
} from "@kymo/core"
import { type Cell, LABEL_FONT_PX, type SheetPlan, type Target, paginate } from "@kymo/layout"
import { Effect } from "effect"
import type { ViewResult } from "./Output.ts"
import type { Paging } from "./Sheet.ts"
import { checkFrames, frameRef, frameSize, readFrames, spanOf } from "./internal/Frames.ts"
import { writePages } from "./internal/Pages.ts"
import { BAR_FILL, INK, line, rect, text } from "./internal/Svg.ts"

/** Samples drawn when the caller does not say. */
export const FILMSTRIP_DEFAULT_COUNT = 12

export interface FilmstripOptions extends Paging {
  readonly source: Source
  /** First and last frame to sample between, inclusive. Default: the whole timeline. */
  readonly range?: { readonly first: FrameIndex; readonly last: FrameIndex }
  /** Evenly spaced samples, including both ends. Default 12. */
  readonly count?: number
  readonly outDir: string
  readonly target: Target
  readonly labelStyle: Address.LabelStyle
}

/** `count` frames spread evenly over [first, last], both ends included, without repeats. */
export const evenSamples = (first: number, last: number, count: number): ReadonlyArray<FrameIndex> => {
  if (count === 1 || first === last) return [frameIndex(first)]
  const out = Array.from({ length: count }, (_, k) => Math.round(first + (k * (last - first)) / (count - 1)))
  return [...new Set(out)].map(frameIndex)
}

const TICK_MAJOR_PX = 14
const TICK_MINOR_PX = 7
const MINOR_PER_GAP = 4

/** One ruler under a row: a baseline, a major tick at each frame's centre with its label, minor ticks between. */
const ruler = (
  timeline: Timeline,
  style: Address.LabelStyle,
  row: ReadonlyArray<{ readonly cell: Cell; readonly index: number }>
): string => {
  const left = row[0]!.cell.label
  const right = row[row.length - 1]!.cell.label
  const bar = { x: left.x, y: left.y, width: right.x + right.width - left.x, height: left.height }
  const top = bar.y + 4
  const centres = row.map(({ cell }) => cell.frame.x + cell.frame.width / 2)
  let out = rect(bar, BAR_FILL) + line(bar.x, top, bar.x + bar.width, top, INK, 2)
  row.forEach(({ index }, k) => {
    const x = centres[k]!
    out += line(x, top, x, top + TICK_MAJOR_PX, INK, 2)
    out += text(
      x,
      top + TICK_MAJOR_PX + (bar.height - TICK_MAJOR_PX - 4) / 2,
      Address.styledLabel(timeline.rate, index, style),
      {
        size: LABEL_FONT_PX,
        anchor: "middle"
      }
    )
    const next = centres[k + 1]
    if (next === undefined) return
    for (let m = 1; m < MINOR_PER_GAP; m++) {
      const mx = Math.round(x + ((next - x) * m) / MINOR_PER_GAP)
      out += line(mx, top, mx, top + TICK_MINOR_PX, INK, 1)
    }
  })
  return out
}

const rulers = (
  timeline: Timeline,
  style: Address.LabelStyle,
  plan: SheetPlan,
  indices: ReadonlyArray<number>
): string =>
  Array.from({ length: plan.rows }, (_, r) =>
    plan.cells.flatMap((cell, k) => (cell.row === r ? [{ cell, index: indices[k]! }] : []))
  )
    .filter((row) => row.length > 0)
    .map((row) => ruler(timeline, style, row))
    .join("")

/**
 * Evenly sampled frames in reading order with a timecode ruler under each row, so spacing in
 * time reads along the strip. Written as `<span>.filmstrip.png`.
 */
export const filmstrip = Effect.fn("filmstrip")(function* (
  o: FilmstripOptions
): Effect.fn.Return<ViewResult, KymoError> {
  const { timeline } = o.source
  const count = o.count ?? FILMSTRIP_DEFAULT_COUNT
  if (!Number.isInteger(count) || count < 1 || count > FRAME_CAP)
    return yield* new InvalidInput({
      message: `A filmstrip samples 1 to ${FRAME_CAP} frames, not ${count}.`,
      hint: `Omit count for ${FILMSTRIP_DEFAULT_COUNT}.`
    })
  const first = o.range?.first ?? frameIndex(0)
  const last = o.range?.last ?? frameIndex(Math.max(0, timeline.frameCount - 1))
  if (last < first)
    return yield* new InvalidInput({
      message: `The range ${Address.format(timeline.rate, first)}..${Address.format(timeline.rate, last)} ends before it starts.`,
      hint: "Write the earlier address first."
    })
  const frames = evenSamples(first, last, count)
  yield* checkFrames(o.source, frames)
  const size = yield* frameSize(o.source)
  const pages = yield* Effect.fromResult(
    paginate({
      items: frames.length,
      frame: size,
      target: o.target,
      labelChars: Math.max(...frames.map((i) => Address.styledLabel(timeline.rate, i, o.labelStyle).length)),
      bar: "ruler",
      cursor: o.cursor,
      maxSheets: o.maxSheets
    })
  )
  const destination = {
    view: "filmstrip",
    outDir: o.outDir,
    fileName: (span: string) => `${span}.filmstrip.png`
  } as const
  return yield* writePages(destination, pages, frames, (plan, indices) =>
    Effect.map(readFrames(o.source, indices, Math.max(plan.frame.width, plan.frame.height)), (decoded) => ({
      span: spanOf(timeline, indices),
      frames: decoded.map((f) => frameRef(timeline, f)),
      drawing: {
        width: plan.width,
        height: plan.height,
        tiles: decoded.map((f, k) => ({ image: f.image, rect: plan.cells[k]!.frame })),
        overlay: rulers(timeline, o.labelStyle, plan, indices)
      }
    }))
  )
})
