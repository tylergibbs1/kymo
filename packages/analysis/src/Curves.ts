/** Normalised easing curves (0 at rest, 1 at the target) and a small optimiser to fit them. */

export interface Bezier {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

export const PRESETS = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 },
  ease: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  "ease-in": { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  "ease-out": { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  "ease-in-out": { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }
} as const satisfies Record<string, Bezier>
export type Preset = keyof typeof PRESETS

const cubic = (p1: number, p2: number, t: number) => {
  const u = 1 - t
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
}

/** CSS `cubic-bezier` progress at time fraction `x`. `x1`, `x2` must be in 0..1, as in CSS. */
export const bezierAt = (b: Bezier, x: number): number => {
  if (x <= 0) return 0
  if (x >= 1) return 1
  let t = x
  for (let i = 0; i < 8; i++) {
    const err = cubic(b.x1, b.x2, t) - x
    if (Math.abs(err) < 1e-7) return cubic(b.y1, b.y2, t)
    const u = 1 - t
    const d = 3 * u * u * b.x1 + 6 * u * t * (b.x2 - b.x1) + 3 * t * t * (1 - b.x2)
    if (Math.abs(d) < 1e-6) break
    t -= err / d
  }
  let lo = 0
  let hi = 1
  t = x
  for (let i = 0; i < 40; i++) {
    if (cubic(b.x1, b.x2, t) < x) lo = t
    else hi = t
    t = (lo + hi) / 2
  }
  return cubic(b.y1, b.y2, t)
}

/** A damped harmonic oscillator released from rest at 0, settling at 1. Mass 1. */
export interface Spring {
  /** Natural angular frequency, rad/s. */
  readonly omega: number
  readonly zeta: number
}

export const springAt = ({ omega, zeta }: Spring, seconds: number): number => {
  const t = seconds
  if (Math.abs(zeta - 1) < 1e-4) return 1 - Math.exp(-omega * t) * (1 + omega * t)
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t))
  }
  const s = Math.sqrt(zeta * zeta - 1)
  const r1 = -omega * (zeta - s)
  const r2 = -omega * (zeta + s)
  return 1 + (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r1 - r2)
}

/** Nelder–Mead simplex minimisation. Deterministic for a given start. */
export const minimize = (
  f: (p: ReadonlyArray<number>) => number,
  start: ReadonlyArray<number>,
  step: ReadonlyArray<number>,
  iterations = 400
): { readonly point: ReadonlyArray<number>; readonly value: number } => {
  const n = start.length
  let simplex = [start, ...start.map((_, i) => start.map((v, j) => (i === j ? v + step[j]! : v)))].map(
    (p) => ({ p, v: f(p) })
  )
  const combine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>, t: number) =>
    a.map((v, i) => v + t * (b[i]! - v))
  for (let it = 0; it < iterations; it++) {
    simplex.sort((a, b) => a.v - b.v)
    const best = simplex[0]!
    const worst = simplex[n]!
    if (Math.abs(worst.v - best.v) < 1e-12) break
    const centroid = start.map((_, i) => simplex.slice(0, n).reduce((s, x) => s + x.p[i]!, 0) / n)
    const reflected = combine(centroid, worst.p, -1)
    const fr = f(reflected)
    if (fr < best.v) {
      const expanded = combine(centroid, worst.p, -2)
      const fe = f(expanded)
      simplex[n] = fe < fr ? { p: expanded, v: fe } : { p: reflected, v: fr }
    } else if (fr < simplex[n - 1]!.v) {
      simplex[n] = { p: reflected, v: fr }
    } else {
      const contracted = combine(centroid, worst.p, 0.5)
      const fc = f(contracted)
      if (fc < worst.v) simplex[n] = { p: contracted, v: fc }
      else
        simplex = simplex
          .map((x, i) => (i === 0 ? x : { p: combine(best.p, x.p, 0.5), v: 0 }))
          .map((x) => ({ p: x.p, v: f(x.p) }))
    }
  }
  simplex.sort((a, b) => a.v - b.v)
  return { point: simplex[0]!.p, value: simplex[0]!.v }
}
