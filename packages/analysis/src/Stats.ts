export const mean = (xs: ReadonlyArray<number>): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

export const median = (xs: ReadonlyArray<number>): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Median absolute deviation scaled to estimate a standard deviation. */
export const robustSigma = (xs: ReadonlyArray<number>): number => {
  const m = median(xs)
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)))
}

/** Min, max (with where, first wins), mean and count of the known values; all 0 when none is known. */
export interface Summary {
  readonly min: number
  readonly max: number
  /** Position of the first maximum in the input, or 0. */
  readonly maxAt: number
  readonly mean: number
  readonly count: number
}

/**
 * The one place summary statistics come from: every figure reads the same known values, so a mean
 * can never fall outside its min and max.
 */
export const summarize = (values: ReadonlyArray<number | null>): Summary => {
  let min = Infinity
  let max = -Infinity
  let maxAt = 0
  let sum = 0
  let count = 0
  values.forEach((v, k) => {
    if (v === null) return
    if (v < min) min = v
    if (v > max) {
      max = v
      maxAt = k
    }
    sum += v
    count++
  })
  return count === 0
    ? { min: 0, max: 0, maxAt: 0, mean: 0, count: 0 }
    : { min, max, maxAt, mean: Math.min(max, Math.max(min, sum / count)), count }
}

export const std = (xs: ReadonlyArray<number>): number => {
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

/** Values at `k - radius .. k + radius`, excluding `k`, clipped to the array. */
export const neighbours = <A>(xs: ReadonlyArray<A>, k: number, radius: number): Array<A> => {
  const out: Array<A> = []
  for (let j = Math.max(0, k - radius); j <= Math.min(xs.length - 1, k + radius); j++) {
    if (j !== k) out.push(xs[j]!)
  }
  return out
}

export const round = (x: number, digits = 4): number => {
  const p = 10 ** digits
  return Math.round(x * p) / p
}
