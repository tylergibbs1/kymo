import { RgbImage, type ReadOptions, type Size } from "@kymo/core"

/** The output size for a read: the source size, shrunk (never grown) so the long edge fits `maxEdge`. */
export const fitWithin = (size: Size, options: ReadOptions | undefined): Size => {
  const maxEdge = options?.maxEdge
  const long = Math.max(size.width, size.height)
  if (maxEdge === undefined || long <= maxEdge) return size
  const scale = Math.max(1, Math.floor(maxEdge)) / long
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale))
  }
}

/** Area-average downscale, for in-process sources. Returns the image itself when no scaling is needed. */
export const resizeTo = (image: RgbImage, target: Size): RgbImage => {
  if (image.width === target.width && image.height === target.height) return image
  const { width: sw, height: sh, data: src } = image
  const { width: tw, height: th } = target
  const out = new Uint8Array(tw * th * 3)
  const fx = sw / tw
  const fy = sh / th
  for (let ty = 0; ty < th; ty++) {
    const y0 = ty * fy
    const y1 = y0 + fy
    for (let tx = 0; tx < tw; tx++) {
      const x0 = tx * fx
      const x1 = x0 + fx
      let r = 0
      let g = 0
      let b = 0
      let area = 0
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx))
          const i = (sy * sw + sx) * 3
          r += src[i]! * w
          g += src[i + 1]! * w
          b += src[i + 2]! * w
          area += w
        }
      }
      const o = (ty * tw + tx) * 3
      out[o] = Math.round(r / area)
      out[o + 1] = Math.round(g / area)
      out[o + 2] = Math.round(b / area)
    }
  }
  return RgbImage.make(tw, th, out)
}
