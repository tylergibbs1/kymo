import { Predicate, Schema, SchemaTransformation } from "effect"

/** An easing curve, parsed from CSS-like text. `progress` maps a time to a position, both starting at 0. */
export type Easing =
  | {
      readonly _tag: "CubicBezier"
      readonly x1: number
      readonly y1: number
      readonly x2: number
      readonly y2: number
    }
  | { readonly _tag: "Spring"; readonly stiffness: number; readonly damping: number }

const bezier = (x1: number, y1: number, x2: number, y2: number): Easing => ({
  _tag: "CubicBezier",
  x1,
  y1,
  x2,
  y2
})

const NAMED: Readonly<Record<string, Easing>> = {
  linear: bezier(0, 0, 1, 1),
  ease: bezier(0.25, 0.1, 0.25, 1),
  "ease-in": bezier(0.42, 0, 1, 1),
  "ease-out": bezier(0, 0, 0.58, 1),
  "ease-in-out": bezier(0.42, 0, 0.58, 1)
}

const NUM = String.raw`\s*(-?\d+(?:\.\d+)?)\s*`
const BEZIER = new RegExp(String.raw`^cubic-bezier\(${NUM},${NUM},${NUM},${NUM}\)$`)
const SPRING = new RegExp(String.raw`^spring\(${NUM},${NUM}\)$`)

const parse = (text: string): Easing => {
  const named = NAMED[text]
  if (named) return named
  const b = BEZIER.exec(text)
  if (b) return bezier(Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4]))
  const s = SPRING.exec(text)!
  return { _tag: "Spring", stiffness: Number(s[1]), damping: Number(s[2]) }
}

const format = (e: Easing): string =>
  e._tag === "Spring"
    ? `spring(${e.stiffness},${e.damping})`
    : `cubic-bezier(${e.x1},${e.y1},${e.x2},${e.y2})`

const EXPECTED =
  "linear, ease, ease-in, ease-out, ease-in-out, cubic-bezier(x1,y1,x2,y2) with x1 and x2 in 0..1, or spring(stiffness,damping) with both > 0"

const isValid = (text: string): boolean => {
  if (text in NAMED) return true
  const b = BEZIER.exec(text)
  if (b) return [b[1], b[3]].every((x) => Number(x) >= 0 && Number(x) <= 1)
  const s = SPRING.exec(text)
  return s !== null && Number(s[1]) > 0 && Number(s[2]) > 0
}

/** `easing=ease-in-out`, `easing=cubic-bezier(0.2,0,0,1)`, `easing=spring(170,26)`. */
export const EasingParam = Schema.String.check(
  Schema.makeFilter((text: string) => isValid(text), { expected: EXPECTED })
).pipe(
  Schema.decodeTo(
    Schema.declare(
      (u): u is Easing => Predicate.isTagged(u, "CubicBezier") || Predicate.isTagged(u, "Spring")
    ),
    SchemaTransformation.transform({ decode: parse, encode: format })
  )
)

/** Solve a CSS cubic-bézier for y at x, by Newton steps falling back to bisection. */
const cubicBezier = (e: Extract<Easing, { _tag: "CubicBezier" }>, x: number): number => {
  const coord = (a: number, b: number, s: number) =>
    3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3
  const slope = (a: number, b: number, s: number) =>
    3 * (1 - s) ** 2 * a + 6 * (1 - s) * s * (b - a) + 3 * s * s * (1 - b)
  let s = x
  for (let k = 0; k < 8; k++) {
    const err = coord(e.x1, e.x2, s) - x
    if (Math.abs(err) < 1e-9) return coord(e.y1, e.y2, s)
    const d = slope(e.x1, e.x2, s)
    if (Math.abs(d) < 1e-9) break
    s -= err / d
  }
  let lo = 0
  let hi = 1
  s = x
  for (let k = 0; k < 60; k++) {
    if (coord(e.x1, e.x2, s) < x) lo = s
    else hi = s
    s = (lo + hi) / 2
  }
  return coord(e.y1, e.y2, s)
}

/** Unit-mass spring from 0 toward 1 at rest, `seconds` after release. */
const spring = (e: Extract<Easing, { _tag: "Spring" }>, seconds: number): number => {
  const w0 = Math.sqrt(e.stiffness)
  const zeta = e.damping / (2 * w0)
  const t = seconds
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t)
  const root = Math.sqrt(zeta * zeta - 1)
  const r1 = -w0 * (zeta - root)
  const r2 = -w0 * (zeta + root)
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1)
}

/**
 * Progress at a point in the motion. Curves take the normalized time through the span (0..1);
 * springs are physical and take seconds since release, so they ignore the span's end.
 */
export const progress = (e: Easing, normalized: number, seconds: number): number => {
  if (e._tag === "Spring") return seconds <= 0 ? 0 : spring(e, seconds)
  if (normalized <= 0) return 0
  if (normalized >= 1) return 1
  return cubicBezier(e, normalized)
}
