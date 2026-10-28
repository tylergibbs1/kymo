import { BackendFailure, RgbImage } from "@kymo/core"
import type { Rect } from "@kymo/layout"
import { Effect } from "effect"
import sharp from "sharp"
import { svgDocument } from "./Svg.ts"

const SHEET_FILL = { r: 24, g: 24, b: 24 }
/** A decoded frame within this many pixels of its cell is stretched to fit exactly (rounding). */
const SNAP_PX = 2

export interface Tile {
  readonly image: RgbImage
  readonly rect: Rect
}

/** Everything one PNG shows: pixels placed into rects, then one SVG layer of labels and marks on top. */
export interface Drawing {
  readonly width: number
  readonly height: number
  readonly tiles: ReadonlyArray<Tile>
  /** SVG elements in sheet coordinates. */
  readonly overlay: string
}

const backend = (what: string) => (cause: unknown) =>
  new BackendFailure({
    message: `Image rendering failed while ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
    hint: "This is a kymo or sharp problem, not an input problem; report it with the command that failed."
  })

const raw = (image: RgbImage) => ({ raw: { width: image.width, height: image.height, channels: 3 as const } })

/** Resize to exactly this size. */
export const resize = (
  image: RgbImage,
  width: number,
  height: number
): Effect.Effect<RgbImage, BackendFailure> =>
  image.width === width && image.height === height
    ? Effect.succeed(image)
    : Effect.tryPromise({
        try: () =>
          sharp(image.data, raw(image))
            .resize(width, height, { fit: "fill", kernel: "lanczos3" })
            .raw()
            .toBuffer()
            .then((data) => RgbImage.make(width, height, new Uint8Array(data))),
        catch: backend("resizing a frame")
      })

/** Where an image lands in a rect: filled when it is the rect's size give or take rounding, else centred without enlarging. */
const fit = (image: RgbImage, r: Rect): Rect => {
  if (Math.abs(image.width - r.width) <= SNAP_PX && Math.abs(image.height - r.height) <= SNAP_PX) return r
  const scale = Math.min(1, r.width / image.width, r.height / image.height)
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  return {
    x: r.x + Math.floor((r.width - width) / 2),
    y: r.y + Math.floor((r.height - height) / 2),
    width,
    height
  }
}

/** An encoded PNG and its final pixel size, which is smaller than the drawing's if it had to be scaled. */
export interface Png {
  readonly bytes: Uint8Array
  readonly width: number
  readonly height: number
}

/** Attempts to scale an over-budget image down before giving up. */
const MAX_SCALE_STEPS = 6

/**
 * Encode RGB pixels as a PNG of at most `maxBytes`: lossless first; then a 256-colour palette, which
 * keeps label text crisp and shrinks photographic sheets about 3x; then the palette image scaled
 * down by the square root of the overshoot (plus a margin) until it fits.
 */
const encodeWithin = async (data: Buffer, width: number, height: number, maxBytes: number): Promise<Png> => {
  const input = { raw: { width, height, channels: 3 as const } }
  const lossless = await sharp(data, input).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer()
  if (lossless.length <= maxBytes) return { bytes: new Uint8Array(lossless), width, height }
  const palette = (w: number, h: number) =>
    sharp(data, input)
      .resize(w, h, { fit: "fill", kernel: "lanczos3" })
      .png({ palette: true, colours: 256, dither: 1, effort: 7, compressionLevel: 9 })
      .toBuffer()
  let w = width
  let h = height
  let png = await palette(w, h)
  for (let step = 0; png.length > maxBytes && step < MAX_SCALE_STEPS; step++) {
    const scale = Math.sqrt(maxBytes / png.length) * 0.92
    w = Math.max(1, Math.floor(w * scale))
    h = Math.max(1, Math.floor(h * scale))
    png = await palette(w, h)
  }
  if (png.length > maxBytes)
    throw new Error(`a ${width}x${height} image does not fit ${maxBytes} bytes even at ${w}x${h}`)
  return { bytes: new Uint8Array(png), width: w, height: h }
}

/** Render a drawing to a PNG of at most `maxBytes`. Same drawing, same bytes. */
export const renderPng = Effect.fnUntraced(function* (d: Drawing, maxBytes: number) {
  const layers = yield* Effect.forEach(d.tiles, (tile) => {
    const at = fit(tile.image, tile.rect)
    return Effect.map(resize(tile.image, at.width, at.height), (image) => ({
      input: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      ...raw(image),
      left: at.x,
      top: at.y
    }))
  })
  const svg = { input: Buffer.from(svgDocument(d.width, d.height, d.overlay)), left: 0, top: 0 }
  return yield* Effect.tryPromise({
    try: async () => {
      const composed = await sharp({
        create: { width: d.width, height: d.height, channels: 3, background: SHEET_FILL }
      })
        .composite([...layers, svg])
        .raw()
        .toBuffer({ resolveWithObject: true })
      const rgb =
        composed.info.channels === 3
          ? composed.data
          : await sharp(composed.data, {
              raw: { width: d.width, height: d.height, channels: composed.info.channels }
            })
              .removeAlpha()
              .raw()
              .toBuffer()
      return await encodeWithin(rgb, d.width, d.height, maxBytes)
    },
    catch: backend("composing a sheet")
  })
})
