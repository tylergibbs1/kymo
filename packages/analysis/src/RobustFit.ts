/**
 * A straight line through pixel pairs that ignores the pixels it does not fit: `y ≈ slope · x (+ offset)`
 * by iteratively reweighted least squares with Tukey's biweight. Pixels covered by something else
 * (a translucent band passing over), or on an edge that moved by a fraction of a pixel, fit badly and
 * get no weight, so the slope is what the rest of the pixels agree on.
 */

/** Tukey's biweight constant: 95% efficiency on Gaussian noise. */
const TUKEY = 4.685

const ROUNDS = 6

export interface Line {
  readonly slope: number
  readonly offset: number
  /** One standard error of `slope`, from the residuals of the pixels that fit. */
  readonly slopeNoise: number
  /** Share of the pixels that fit the line (within three residual deviations), 0..1. */
  readonly fitting: number
  /** Whether each pair fits the line (within three residual deviations). */
  readonly fits: (k: number) => boolean
}

/**
 * Fit `ys ≈ slope · xs (+ offset)` over `n` pairs. `noise` is the least residual deviation assumed
 * (grey levels): encoder noise, so a near-perfect fit does not reject pixels for a level of jitter.
 * Undefined when `xs` has no spread among the pixels that carry weight. `from` starts the search at
 * a given line (its pixels within a few `noise` of it) instead of at the least-squares one.
 */
export const robustLine = (
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  n: number,
  noise: number,
  withOffset: boolean,
  from?: { readonly slope: number; readonly offset: number }
): Line | undefined => {
  const w = new Float64Array(n).fill(1)
  const r = new Float64Array(n)
  if (from !== undefined)
    for (let k = 0; k < n; k++) {
      const u = (ys[k]! - from.slope * xs[k]! - from.offset) / (TUKEY * noise)
      w[k] = Math.abs(u) >= 1 ? 0 : (1 - u * u) ** 2
    }
  let slope = 0
  let offset = 0
  let sigma = noise
  let spread = 0
  for (let round = 0; round <= ROUNDS; round++) {
    let sw = 0
    let sx = 0
    let sy = 0
    for (let k = 0; k < n; k++) {
      sw += w[k]!
      sx += w[k]! * xs[k]!
      sy += w[k]! * ys[k]!
    }
    if (sw <= 0) return undefined
    const mx = withOffset ? sx / sw : 0
    const my = withOffset ? sy / sw : 0
    let sxx = 0
    let sxy = 0
    for (let k = 0; k < n; k++) {
      const dx = xs[k]! - mx
      sxx += w[k]! * dx * dx
      sxy += w[k]! * dx * (ys[k]! - my)
    }
    if (sxx <= 1e-9) return undefined
    slope = sxy / sxx
    offset = my - slope * mx
    spread = sxx
    for (let k = 0; k < n; k++) r[k] = ys[k]! - slope * xs[k]! - offset
    if (round === ROUNDS) break
    // The scale comes from the best-fitting quarter, so it holds while up to three quarters of the
    // pixels follow something else (a band covering most of the subject would inflate a median).
    sigma = Math.max(noise, quarterAbs(r, n) / QUARTER_OF_NORMAL)
    const c = TUKEY * sigma
    for (let k = 0; k < n; k++) {
      const u = r[k]! / c
      w[k] = Math.abs(u) >= 1 ? 0 : (1 - u * u) ** 2
    }
  }
  const fits = (k: number) => Math.abs(r[k]!) <= 3 * sigma
  let fitting = 0
  for (let k = 0; k < n; k++) if (fits(k)) fitting++
  return { slope, offset, slopeNoise: sigma / Math.sqrt(spread), fitting: fitting / n, fits }
}

/** The 25th percentile of |x| for a standard normal x: dividing by it turns that quantile into σ. */
const QUARTER_OF_NORMAL = 0.3186

const quarterAbs = (r: Float64Array, n: number): number => {
  const a = new Float64Array(n)
  for (let k = 0; k < n; k++) a[k] = Math.abs(r[k]!)
  a.sort()
  return n === 0 ? 0 : a[Math.floor((n - 1) / 4)]!
}
