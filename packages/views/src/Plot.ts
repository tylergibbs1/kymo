import {
  Address,
  type FrameIndex,
  InvalidInput,
  type KymoError,
  type Source,
  type Track,
  frameIndex,
  secondsAt
} from "@kymo/core"
import { TOKEN_TILE_PX, type Target, targetBudget } from "@kymo/layout"
import { Effect } from "effect"
import type { ViewImage } from "./Output.ts"
import { fileSafe } from "./internal/Frames.ts"
import { writeImage } from "./internal/Pages.ts"
import { line, rect, text } from "./internal/Svg.ts"

/** Chart width, unless the target's long edge is smaller. */
export const PLOT_WIDTH_PX = 1280
/** Preferred height of one track's panel. */
export const PLOT_PANEL_PX = 360
/** Panels are never squeezed below this; plot fewer tracks per image instead. */
export const PLOT_MIN_PANEL_PX = 200

const TITLE_PX = 28
const TICK_PX = 22
const MARGIN = { left: 130, right: 36, top: 56, bottom: 56 } as const
const X_TICKS = 6
const Y_TICKS = 5
const CURVE = "#4cc9f0"
const GRID = "#3a3a3a"

export interface PlotOptions {
  readonly source: Source
  /** Track names; one panel each, top to bottom. */
  readonly tracks: ReadonlyArray<string>
  /** Frames to plot, inclusive. Default: every sample. */
  readonly range?: { readonly first: FrameIndex; readonly last: FrameIndex }
  readonly outDir: string
  readonly target: Target
}

/** A round step (1, 2 or 5 × 10^k) giving about `ticks` divisions of `span`. */
const niceStep = (span: number, ticks: number): number => {
  const raw = span / ticks
  const mag = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / mag
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * mag
}

const formatValue = (v: number): string => String(Number(v.toPrecision(4)))

const panel = (
  track: Track,
  first: number,
  last: number,
  top: number,
  width: number,
  height: number,
  rate: Source["timeline"]["rate"]
) => {
  const x0 = MARGIN.left
  const x1 = width - MARGIN.right
  const y0 = top + MARGIN.top
  const y1 = top + height - MARGIN.bottom
  let out = text(16, top + TITLE_PX, `${track.name} (${track.unit})`, { size: TITLE_PX })
  const xAt = (f: number) => x0 + ((f - first) / Math.max(1, last - first)) * (x1 - x0)
  const ticksX = [
    ...new Set(
      Array.from({ length: X_TICKS }, (_, k) => Math.round(first + (k * (last - first)) / (X_TICKS - 1)))
    )
  ]
  for (const f of ticksX) {
    const x = Math.round(xAt(f))
    out += line(x, y0, x, y1, GRID) + line(x, y1, x, y1 + 8, "#bbbbbb")
    // The last label ends at its tick so it stays inside the image.
    const anchor = f === last && f !== first ? "end" : "middle"
    out += text(x, y1 + 8 + TICK_PX * 0.8, Address.format(rate, f), { size: TICK_PX, anchor })
  }
  const values: Array<number> = []
  for (let f = first; f <= last; f++) {
    const v = track.samples[f]
    if (v !== null && v !== undefined) values.push(v)
  }
  out += rect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, "none", ` stroke="#777777"`)
  if (values.length === 0)
    return (
      out +
      text((x0 + x1) / 2, (y0 + y1) / 2, "no samples in this range", { size: TICK_PX, anchor: "middle" })
    )
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1
    lo -= pad
    hi += pad
  }
  const step = niceStep(hi - lo, Y_TICKS - 1)
  lo = Math.floor(lo / step) * step
  hi = Math.ceil(hi / step) * step
  const yAt = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0)
  for (let v = lo; v <= hi + step / 2; v += step) {
    const y = Math.round(yAt(v))
    out += line(x0, y, x1, y, GRID) + text(x0 - 10, y, formatValue(v), { size: TICK_PX, anchor: "end" })
  }
  // Unknown samples break the curve rather than being interpolated across.
  const runs: Array<Array<string>> = [[]]
  for (let f = first; f <= last; f++) {
    const v = track.samples[f]
    if (v === null || v === undefined) {
      if (runs[runs.length - 1]!.length > 0) runs.push([])
      continue
    }
    runs[runs.length - 1]!.push(`${xAt(f).toFixed(1)},${yAt(v).toFixed(1)}`)
  }
  for (const run of runs) {
    if (run.length === 1) {
      const [cx, cy] = run[0]!.split(",")
      out += `<circle cx="${cx}" cy="${cy}" r="3" fill="${CURVE}"/>`
    } else if (run.length > 1)
      out += `<polyline points="${run.join(" ")}" fill="none" stroke="${CURVE}" stroke-width="2"/>`
  }
  return out
}

/**
 * Curves of numeric tracks, one panel per track, x in addresses and y in the track's unit.
 * Written as `<span>.plot.<tracks>.png`.
 */
export const plot = Effect.fn("plot")(function* (o: PlotOptions): Effect.fn.Return<ViewImage, KymoError> {
  const { timeline } = o.source
  if (o.tracks.length === 0)
    return yield* new InvalidInput({
      message: "No tracks to plot.",
      hint: `This source has: ${timeline.tracks.map((t) => t.name).join(", ") || "no tracks"}.`
    })
  const tracks = yield* Effect.forEach(o.tracks, (name) => o.source.track(name))
  const samples = Math.min(...tracks.map((t) => t.samples.length))
  const first = o.range?.first ?? 0
  const last = o.range?.last ?? samples - 1
  if (samples === 0 || first > last || last >= samples)
    return yield* new InvalidInput({
      message: `Cannot plot ${Address.format(timeline.rate, first)}..${Address.format(timeline.rate, last)}: the tracks have ${samples} samples.`,
      hint: `Use a range within 0f..${Address.format(timeline.rate, Math.max(0, samples - 1))}, earlier address first.`
    })
  const limit = targetBudget(o.target)
  const width = Math.min(PLOT_WIDTH_PX, limit.maxEdge)
  const maxHeight = Math.min(
    limit.maxEdge,
    Math.floor(limit.maxTokens / Math.ceil(width / TOKEN_TILE_PX)) * TOKEN_TILE_PX
  )
  const panelHeight = Math.min(PLOT_PANEL_PX, Math.floor(maxHeight / tracks.length))
  if (panelHeight < PLOT_MIN_PANEL_PX)
    return yield* new InvalidInput({
      message: `${tracks.length} tracks do not fit legibly in one plot at this target.`,
      hint: `Plot at most ${Math.max(1, Math.floor(maxHeight / PLOT_MIN_PANEL_PX))} tracks per call.`
    })
  const height = panelHeight * tracks.length
  const ref = (i: number) => ({
    address: Address.format(timeline.rate, i),
    index: frameIndex(i),
    t: secondsAt(timeline.rate, frameIndex(i))
  })
  return yield* writeImage(
    {
      view: "plot",
      outDir: o.outDir,
      fileName: (span) => `${span}.plot.${o.tracks.map(fileSafe).join("+")}.png`
    },
    {
      span: Address.spanName(timeline.rate, first, last),
      frames: first === last ? [ref(first)] : [ref(first), ref(last)],
      drawing: {
        width,
        height,
        tiles: [],
        overlay: tracks
          .map((t, k) => panel(t, first, last, k * panelHeight, width, panelHeight, timeline.rate))
          .join("")
      }
    }
  )
})
