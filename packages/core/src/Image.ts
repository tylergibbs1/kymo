/** A decoded frame: tightly packed 8-bit RGB, row-major. The one pixel format views and analysis see. */
export class RgbImage {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array

  private constructor(width: number, height: number, data: Uint8Array) {
    this.width = width
    this.height = height
    this.data = data
  }

  static make(width: number, height: number, data: Uint8Array): RgbImage {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError(`RgbImage size must be positive integers, got ${width}x${height}`)
    }
    if (data.length !== width * height * 3) {
      throw new RangeError(
        `RgbImage ${width}x${height} needs ${width * height * 3} bytes, got ${data.length}`
      )
    }
    return new RgbImage(width, height, data)
  }

  static blank(width: number, height: number, rgb: readonly [number, number, number] = [0, 0, 0]): RgbImage {
    const data = new Uint8Array(width * height * 3)
    for (let i = 0; i < data.length; i += 3) {
      data[i] = rgb[0]
      data[i + 1] = rgb[1]
      data[i + 2] = rgb[2]
    }
    return RgbImage.make(width, height, data)
  }
}
