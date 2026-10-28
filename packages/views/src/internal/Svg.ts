import { LABEL_FONT_PX, type Rect } from "@kymo/layout"

export const FONT_FAMILY = "Menlo, DejaVu Sans Mono, Consolas, monospace"
export const INK = "#f2f2f2"
export const BAR_FILL = "#000000"

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export const svgDocument = (width: number, height: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`

export interface TextOptions {
  readonly size: number
  readonly anchor?: "start" | "middle" | "end"
  readonly fill?: string
}

/** Text whose baseline is placed so the glyphs sit vertically centred on `centerY`. */
export const text = (x: number, centerY: number, content: string, o: TextOptions): string =>
  `<text x="${x}" y="${Math.round(centerY + o.size * 0.35)}" font-family="${FONT_FAMILY}" font-size="${o.size}" ` +
  `text-anchor="${o.anchor ?? "start"}" fill="${o.fill ?? INK}">${escapeXml(content)}</text>`

export const rect = (r: Rect, fill: string, extra = ""): string =>
  `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${fill}"${extra}/>`

export const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1): string =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"/>`

/** A frame label: full-size text centred in the bar under the frame. */
export const label = (bar: Rect, content: string): string =>
  rect(bar, BAR_FILL) +
  text(bar.x + bar.width / 2, bar.y + bar.height / 2, content, { size: LABEL_FONT_PX, anchor: "middle" })
