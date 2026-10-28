/**
 * Template matching by zero-mean normalised cross-correlation (ZNCC). ZNCC ignores brightness and
 * contrast, so a subject fading in or out matches as well as a fully opaque one, and only the part
 * of the template that falls inside the frame is compared, so a subject leaving the frame still
 * matches on what is left of it.
 */
import type { Plane } from "./Plane.ts"

/** A template sampled at one pyramid level, with each pixel's offset from the template centre. */
export interface Template {
  readonly w: number
  readonly h: number
  readonly data: Float32Array
  readonly ox: Float32Array
  readonly oy: Float32Array
  /** Variance of the whole template, per pixel. */
  readonly variance: number
}

/** Where the template sits: its centre (continuous coordinates of the level) and scale. */
export interface Pose {
  readonly cx: number
  readonly cy: number
  readonly s: number
}

export interface Score {
  /** ZNCC clipped to 0..1; 0 when either side is flat. */
  readonly q: number
  /** Fraction of the template inside the frame. */
  readonly visible: number
  /** Standard deviation of the frame under the template over the template's: ~opacity of a fade. */
  readonly contrast: number
}

/** Template pixels varying less than this (grey levels², per pixel) carry no structure to correlate. */
const FLAT = 2

const offsets = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => i + 0.5 - n / 2)

const sampler = (p: Plane) => {
  const { width: W, height: H, data: d } = p
  return (x: number, y: number): number => {
    const u = Math.max(0, Math.min(W - 1, x - 0.5))
    const v = Math.max(0, Math.min(H - 1, y - 0.5))
    const x0 = Math.min(Math.floor(u), Math.max(0, W - 2))
    const y0 = Math.min(Math.floor(v), Math.max(0, H - 2))
    const fx = u - x0
    const fy = v - y0
    const x1 = Math.min(x0 + 1, W - 1)
    const y1 = Math.min(y0 + 1, H - 1)
    const top = d[y0 * W + x0]! + fx * (d[y0 * W + x1]! - d[y0 * W + x0]!)
    const bot = d[y1 * W + x0]! + fx * (d[y1 * W + x1]! - d[y1 * W + x0]!)
    return top + fy * (bot - top)
  }
}

/** Sample a w×h template centred on (cx, cy) of `plane`, one plane pixel per template pixel. */
export const cutTemplate = (plane: Plane, cx: number, cy: number, w: number, h: number): Template => {
  const ox = offsets(w)
  const oy = offsets(h)
  const at = sampler(plane)
  const data = new Float32Array(w * h)
  let sum = 0
  let sq = 0
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = at(cx + ox[i]!, cy + oy[j]!)
      data[j * w + i] = v
      sum += v
      sq += v * v
    }
  }
  const n = w * h
  return { w, h, data, ox, oy, variance: Math.max(0, sq / n - (sum / n) ** 2) }
}

/** First and last template index whose sample coordinate `c + s·o` lies inside 0..size. */
const visibleSpan = (o: Float32Array, c: number, s: number, size: number): readonly [number, number] => {
  let a = 0
  let b = o.length - 1
  while (a <= b && c + s * o[a]! - 0.5 < 0) a++
  while (b >= a && c + s * o[b]! - 0.5 > size - 1) b--
  return [a, b]
}

/** ZNCC of `t` against `plane` at `pose`, over the part of the template inside the frame. */
export const score = (plane: Plane, t: Template, pose: Pose): Score => {
  const { width: W, height: H, data: d } = plane
  const { cx, cy, s } = pose
  const [i0, i1] = visibleSpan(t.ox, cx, s, W)
  const [j0, j1] = visibleSpan(t.oy, cy, s, H)
  const cols = i1 - i0 + 1
  const rows = j1 - j0 + 1
  if (cols <= 0 || rows <= 0 || W < 2 || H < 2) return { q: 0, visible: 0, contrast: 0 }
  const visible = (cols * rows) / (t.w * t.h)
  const xs = new Int32Array(cols)
  const fx = new Float32Array(cols)
  for (let i = i0; i <= i1; i++) {
    const u = cx + s * t.ox[i]! - 0.5
    const x0 = Math.min(Math.floor(u), W - 2)
    xs[i - i0] = x0
    fx[i - i0] = u - x0
  }
  let st = 0
  let stt = 0
  let sp = 0
  let spp = 0
  let stp = 0
  const T = t.data
  for (let j = j0; j <= j1; j++) {
    const v = cy + s * t.oy[j]! - 0.5
    const y0 = Math.min(Math.floor(v), H - 2)
    const fy = v - y0
    const r0 = y0 * W
    const r1 = r0 + W
    const tr = j * t.w + i0
    for (let k = 0; k < cols; k++) {
      const x0 = xs[k]!
      const f = fx[k]!
      const a = d[r0 + x0]!
      const b = d[r0 + x0 + 1]!
      const c = d[r1 + x0]!
      const e = d[r1 + x0 + 1]!
      const top = a + f * (b - a)
      const p = top + fy * (c + f * (e - c) - top)
      const tv = T[tr + k]!
      st += tv
      stt += tv * tv
      sp += p
      spp += p * p
      stp += tv * p
    }
  }
  const n = cols * rows
  const vt = stt / n - (st / n) ** 2
  const vp = spp / n - (sp / n) ** 2
  if (vt < FLAT) return { q: 0, visible, contrast: 0 }
  const contrast = Math.sqrt(Math.max(0, vp) / vt)
  if (vp < 1e-6) return { q: 0, visible, contrast }
  const q = (stp / n - (st / n) * (sp / n)) / Math.sqrt(vt * vp)
  return { q: Math.max(0, Math.min(1, q)), visible, contrast }
}

export interface SearchWindow {
  /** Centre positions to try at level 0: every centre in x0..x1 × y0..y1. */
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
  /** The expected centre: breaks ties between equally good matches. */
  readonly px: number
  readonly py: number
}

export interface Found {
  readonly pose: Pose
  readonly score: Score
}

/** Parabola vertex through (-1, a), (0, b), (1, c), in -0.5..0.5. */
const vertex = (a: number, b: number, c: number): number => {
  const d = a - 2 * b + c
  return d >= 0 ? 0 : Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)))
}

/**
 * Best pose in `window`: an exhaustive search on the coarsest level, the three best peaks refined
 * level by level, then sub-pixel position and scale on level 0. `templates[k]` is the template at
 * `levels[k]`. Poses whose template is less than `minVisible` inside the frame are skipped.
 */
export const search = (
  levels: ReadonlyArray<Plane>,
  templates: ReadonlyArray<Template>,
  window: SearchWindow,
  s: number,
  minVisible: number,
  fitScale: boolean
): Found | undefined => {
  const L = templates.length - 1
  const f = 2 ** L
  const coarse = levels[L]!
  const tc = templates[L]!
  const gx0 = Math.floor(window.x0 / f)
  const gx1 = Math.ceil(window.x1 / f)
  const gy0 = Math.floor(window.y0 / f)
  const gy1 = Math.ceil(window.y1 / f)
  const gw = gx1 - gx0 + 1
  const gh = gy1 - gy0 + 1
  const grid = new Float32Array(gw * gh).fill(-1)
  const penalty = 1e-4 / Math.max(1, Math.hypot(gw, gh))
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const pose = { cx: gx0 + gx, cy: gy0 + gy, s }
      const r = score(coarse, tc, pose)
      if (r.visible < minVisible) continue
      const dist = Math.hypot(pose.cx * f - window.px, pose.cy * f - window.py)
      grid[gy * gw + gx] = r.q - penalty * dist
    }
  }
  // Local maxima, best first.
  const peaks: Array<{ x: number; y: number; v: number }> = []
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const v = grid[gy * gw + gx]!
      if (v < 0) continue
      let top = true
      for (let dy = -1; dy <= 1 && top; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx
          const y = gy + dy
          if ((dx || dy) && x >= 0 && y >= 0 && x < gw && y < gh && grid[y * gw + x]! > v) {
            top = false
            break
          }
        }
      }
      if (top) peaks.push({ x: gx0 + gx, y: gy0 + gy, v })
    }
  }
  peaks.sort((a, b) => b.v - a.v)
  let best: Found | undefined
  for (const peak of peaks.slice(0, 3)) {
    const found = refine(levels, templates, { cx: peak.x, cy: peak.y, s }, L, minVisible, fitScale)
    if (found && (!best || found.score.q > best.score.q)) best = found
  }
  return best
}

/** Climb to the best whole-pixel pose on each finer level, then sub-pixel and scale on level 0. */
const refine = (
  levels: ReadonlyArray<Plane>,
  templates: ReadonlyArray<Template>,
  start: Pose,
  from: number,
  minVisible: number,
  fitScale: boolean
): Found | undefined => {
  let pose = start
  let q = -1
  for (let k = from; k >= 0; k--) {
    if (k < from) pose = { cx: pose.cx * 2, cy: pose.cy * 2, s: pose.s }
    const plane = levels[k]!
    const t = templates[k]!
    const at = (cx: number, cy: number) => {
      const r = score(plane, t, { cx, cy, s: pose.s })
      return r.visible < minVisible ? -1 : r.q
    }
    q = at(pose.cx, pose.cy)
    for (let step = 0; step < 8; step++) {
      let bx = pose.cx
      let by = pose.cy
      let bq = q
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const v = at(pose.cx + dx, pose.cy + dy)
          if (v > bq) {
            bq = v
            bx = pose.cx + dx
            by = pose.cy + dy
          }
        }
      }
      if (bx === pose.cx && by === pose.cy) break
      pose = { cx: bx, cy: by, s: pose.s }
      q = bq
    }
  }
  if (q < 0) return undefined
  const plane = levels[0]!
  const t = templates[0]!
  const qAt = (p: Pose) => {
    const r = score(plane, t, p)
    return r.visible < minVisible ? -1 : r.q
  }
  let { cx, cy, s } = pose
  // Sub-pixel position: a parabola through whole-pixel neighbours, then at quarter-pixel spacing.
  const position = () => {
    for (const h of [1, 0.25]) {
      const c = qAt({ cx, cy, s })
      const sx = vertex(qAt({ cx: cx - h, cy, s }), c, qAt({ cx: cx + h, cy, s }))
      const sy = vertex(qAt({ cx, cy: cy - h, s }), c, qAt({ cx, cy: cy + h, s }))
      cx += sx * h
      cy += sy * h
    }
  }
  // Scale, in steps that move the template's edge by about a pixel (then a quarter), so small and
  // large templates resolve scale equally well; each parabola is repeated while its peak sits at the
  // edge of the bracket.
  const edge = 2 / Math.max(t.w, t.h)
  const scale = () => {
    for (const d of [edge, edge / 4]) {
      for (let step = 0; step < 4; step++) {
        const c = qAt({ cx, cy, s })
        const ds = vertex(qAt({ cx, cy, s: s * (1 - d) }), c, qAt({ cx, cy, s: s * (1 + d) }))
        s *= 1 + ds * d
        if (Math.abs(ds) < 0.5) break
      }
    }
  }
  position()
  if (fitScale) {
    // A pop can change scale a lot in one frame: start from the best of a coarse bracket.
    let bq = qAt({ cx, cy, s })
    let bs = s
    for (const f of [0.84, 0.92, 1.08, 1.16]) {
      const v = qAt({ cx, cy, s: s * f })
      if (v > bq + 0.01) {
        bq = v
        bs = s * f
      }
    }
    s = bs
    // Position and scale pull on each other: refine them in turn.
    for (let round = 0; round < 2; round++) {
      scale()
      position()
    }
  }
  const final = score(plane, t, { cx, cy, s })
  const whole = score(plane, t, pose)
  return final.q >= whole.q ? { pose: { cx, cy, s }, score: final } : { pose, score: whole }
}
