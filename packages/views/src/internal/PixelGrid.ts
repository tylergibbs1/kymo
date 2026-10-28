import type { Rect } from "@kymo/layout"
import type { PixelRect } from "./Pixels.ts"
import { line, rect, text } from "./Svg.ts"

/** Grid spacing in source pixels. */
export const GRID_STEP_PX = 100
const GRID_FONT_PX = 16
/** Coordinate labels closer than this on screen are thinned out. */
const MIN_LABEL_GAP_PX = 48
const STROKE = "rgba(0,255,255,0.55)"

/**
 * Lines every 100 source pixels over a frame drawn in `cell`, with source coordinates at the
 * top and left edges. `region` is the part of the source shown (the whole frame, or a crop).
 * For orientation only: positions read off it are approximate.
 */
export const pixelGrid = (cell: Rect, region: PixelRect): string => {
  const sx = cell.width / region.width
  const sy = cell.height / region.height
  const every = [1, 2, 5, 10].find((k) => GRID_STEP_PX * k * Math.min(sx, sy) >= MIN_LABEL_GAP_PX) ?? 20
  // Tags that would spill past the cell's right or bottom edge are dropped.
  const tag = (x: number, y: number, value: number) => {
    const s = String(value)
    const w = s.length * 10 + 6
    if (x + w > cell.x + cell.width || y + GRID_FONT_PX + 4 > cell.y + cell.height) return ""
    return (
      rect({ x, y, width: w, height: GRID_FONT_PX + 4 }, "rgba(0,0,0,0.6)") +
      text(x + 3, y + (GRID_FONT_PX + 4) / 2, s, { size: GRID_FONT_PX })
    )
  }
  let out = ""
  const firstX = Math.ceil(region.x / GRID_STEP_PX) * GRID_STEP_PX
  for (let v = firstX; v < region.x + region.width; v += GRID_STEP_PX) {
    const x = Math.round(cell.x + (v - region.x) * sx)
    out += line(x, cell.y, x, cell.y + cell.height, STROKE)
    if ((v / GRID_STEP_PX) % every === 0) out += tag(x + 2, cell.y + 2, v)
  }
  const firstY = Math.ceil(region.y / GRID_STEP_PX) * GRID_STEP_PX
  for (let v = firstY; v < region.y + region.height; v += GRID_STEP_PX) {
    const y = Math.round(cell.y + (v - region.y) * sy)
    out += line(cell.x, y, cell.x + cell.width, y, STROKE)
    if (v !== 0 && (v / GRID_STEP_PX) % every === 0) out += tag(cell.x + 2, y + 2, v)
  }
  return out
}
