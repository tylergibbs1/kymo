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
