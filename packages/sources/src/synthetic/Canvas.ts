import { RgbImage, type Size } from "@kymo/core"

export type Rgb = readonly [number, number, number]

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const clampByte = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x))

/**
 * A small anti-aliased rasterizer. Shapes take fractional pixel coordinates and cover pixels by area,
 * so sub-pixel motion shows up in the image and centroids match the ground-truth tracks.
 */
export class Canvas {
  readonly width: number
  readonly height: number
  private readonly data: Float32Array

  constructor(size: Size, background: Rgb) {
    this.width = size.width
    this.height = size.height
    this.data = new Float32Array(size.width * size.height * 3)
    for (let i = 0; i < this.data.length; i += 3) this.data.set(background, i)
  }

  private blend(px: number, py: number, color: Rgb, alpha: number) {
    if (alpha <= 0) return
    const i = (py * this.width + px) * 3
    for (let c = 0; c < 3; c++) this.data[i + c] = this.data[i + c]! * (1 - alpha) + color[c]! * alpha
  }

  /** Axis-aligned rectangle with top-left (x, y). */
  rect(x: number, y: number, w: number, h: number, color: Rgb, opacity = 1): this {
    const x0 = Math.max(0, Math.floor(x))
    const x1 = Math.min(this.width, Math.ceil(x + w))
    const y0 = Math.max(0, Math.floor(y))
    const y1 = Math.min(this.height, Math.ceil(y + h))
    for (let py = y0; py < y1; py++) {
      const cy = Math.min(py + 1, y + h) - Math.max(py, y)
      for (let px = x0; px < x1; px++) {
        const cx = Math.min(px + 1, x + w) - Math.max(px, x)
        this.blend(px, py, color, clamp01(cx) * clamp01(cy) * opacity)
      }
    }
    return this
  }

  /** Filled circle with an anti-aliased edge. */
  disc(cx: number, cy: number, r: number, color: Rgb, opacity = 1): this {
    const x0 = Math.max(0, Math.floor(cx - r - 1))
    const x1 = Math.min(this.width, Math.ceil(cx + r + 1))
    const y0 = Math.max(0, Math.floor(cy - r - 1))
    const y1 = Math.min(this.height, Math.ceil(cy + r + 1))
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy)
        this.blend(px, py, color, clamp01(r - d + 0.5) * opacity)
      }
    }
    return this
  }

  /** Add a constant to every channel (a brightness flash). */
  brighten(levels: number): this {
    for (let i = 0; i < this.data.length; i++) this.data[i] = this.data[i]! + levels
    return this
  }

  /** Cross-dissolve toward another canvas of the same size. */
  mix(other: Canvas, amount: number): this {
    for (let i = 0; i < this.data.length; i++) {
      this.data[i] = this.data[i]! * (1 - amount) + other.data[i]! * amount
    }
    return this
  }

  toImage(): RgbImage {
    const out = new Uint8Array(this.data.length)
    for (let i = 0; i < out.length; i++) out[i] = clampByte(this.data[i]!)
    return RgbImage.make(this.width, this.height, out)
  }
}
