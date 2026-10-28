import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Real encoded footage with known defects, built by ffmpeg in a temp directory. Synthetic frames are
 * too clean to catch what breaks on real clips: textured detail that saturates the difference between
 * frames, encoder noise on repeated frames, frame-rate conversions and dissolves.
 */
export interface Footage {
  readonly dir: string
  /** Write a clip and return its path. */
  readonly clip: (name: string, spec: ClipSpec) => string
  readonly dispose: () => void
}

export interface ClipSpec {
  /** Frames to encode, at `fps`. */
  readonly frames: number
  readonly fps: number
  /** Horizontal pan over a detailed texture, in pixels per frame of a 480×270 picture. */
  readonly speed: number
  /** Texture seed, so two shots differ. */
  readonly seed?: number
  /**
   * Where frame n shows the texture, in frames of travel: `n` by default. Return `n - 1` from some
   * frame on to repeat a frame there, `n + 1` to skip one.
   */
  readonly travel?: string
  /** Extra filters after the pan, e.g. `fade=t=in:s=0:n=21` or `fps=60`. */
  readonly then?: ReadonlyArray<string>
  /** x264 quality: higher is noisier. Default 20. */
  readonly crf?: number
}

const ffmpeg = (...args: ReadonlyArray<string>) =>
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args])

const HEIGHT = 270

/** A seeded PRNG (mulberry32), so every run draws the same texture. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * A detailed, non-repeating texture (six octaves of value noise at high contrast), so differences
 * saturate as on film. Drawn here rather than by an ffmpeg filter, so the fixtures work with any
 * ffmpeg build. Written as a PGM, which every ffmpeg reads.
 */
const texture = (path: string, seed: number, width: number): string => {
  const next = random(seed)
  const sum = new Float64Array(width * HEIGHT)
  let weight = 0
  for (let octave = 0, cell = 48, amp = 1; octave < 6; octave++, cell /= 2, amp *= 0.8) {
    const gw = Math.ceil(width / cell) + 2
    const gh = Math.ceil(HEIGHT / cell) + 2
    const grid = Float64Array.from({ length: gw * gh }, next)
    for (let y = 0; y < HEIGHT; y++) {
      const gy = y / cell
      const y0 = Math.floor(gy)
      const fy = gy - y0
      for (let x = 0; x < width; x++) {
        const gx = x / cell
        const x0 = Math.floor(gx)
        const fx = gx - x0
        const at = (i: number, j: number) => grid[(y0 + j) * gw + x0 + i]!
        const top = at(0, 0) + (at(1, 0) - at(0, 0)) * fx
        const bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * fx
        sum[y * width + x]! += amp * (top + (bottom - top) * fy)
      }
    }
    weight += amp
  }
  const pixels = Uint8Array.from(sum, (v) =>
    Math.max(0, Math.min(255, Math.round(128 + 2.5 * 255 * (v / weight - 0.5))))
  )
  writeFileSync(path, Buffer.concat([Buffer.from(`P5\n${width} ${HEIGHT}\n255\n`), pixels]))
  return path
}

export const footage = (): Footage => {
  const dir = mkdtempSync(join(tmpdir(), "kymo-footage-"))
  return {
    dir,
    clip: (name, spec) => {
      const out = join(dir, `${name}.mp4`)
      const travel = (spec.travel ?? "n").replaceAll(",", "\\,")
      const width = 480 + Math.ceil(spec.speed * (spec.frames + 2))
      const filters = [
        `crop=480:270:x='${spec.speed}*(${travel})':y=0`,
        ...(spec.then ?? []),
        "format=yuv420p"
      ]
      ffmpeg(
        "-loop",
        "1",
        "-framerate",
        String(spec.fps),
        "-i",
        texture(join(dir, `${name}.pgm`), spec.seed ?? 1, width),
        "-vf",
        filters.join(","),
        "-frames:v",
        String(spec.frames),
        "-c:v",
        "libx264",
        "-crf",
        String(spec.crf ?? 20),
        out
      )
      return out
    },
    dispose: () => rmSync(dir, { recursive: true, force: true })
  }
}

/** Cross-dissolve from one textured pan to another over `seconds`, starting at `offset` seconds. */
export const dissolve = (
  f: Footage,
  name: string,
  options: {
    readonly fps: number
    readonly offset: number
    readonly seconds: number
    readonly then?: ReadonlyArray<string>
  }
): string => {
  const total = Math.ceil((2 * options.offset + options.seconds) * options.fps)
  const a = f.clip(`${name}-a`, { frames: total, fps: options.fps, speed: 2, seed: 3 })
  const b = f.clip(`${name}-b`, { frames: total, fps: options.fps, speed: 2, seed: 9, travel: `${total}-n` })
  const out = join(f.dir, `${name}.mp4`)
  const after = (options.then ?? []).map((x) => `,${x}`).join("")
  ffmpeg(
    "-i",
    a,
    "-i",
    b,
    "-filter_complex",
    `[1:v]eq=brightness=0.04:saturation=0.5[b];[0:v][b]xfade=transition=fade:duration=${options.seconds}:offset=${options.offset}${after},format=yuv420p`,
    "-c:v",
    "libx264",
    "-crf",
    "20",
    out
  )
  return out
}

/** Still slides of alternating dark and light colours, `each` frames apiece: a hard cut between every two. */
export const slideshow = (
  f: Footage,
  name: string,
  options: { readonly slides: number; readonly each: number; readonly fps: number }
): string => {
  const out = join(f.dir, `${name}.mp4`)
  const colours = Array.from({ length: options.slides }, (_, n) =>
    n % 2 === 0
      ? `0x${(0x203050 + 0x080808 * n).toString(16)}`
      : `0x${(0xc0b090 - 0x040404 * n).toString(16)}`
  )
  const seconds = options.each / options.fps
  ffmpeg(
    ...colours.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=320x180:r=${options.fps}:d=${seconds}`]),
    "-filter_complex",
    `${colours.map((_, n) => `[${n}:v]`).join("")}concat=n=${options.slides}:v=1:a=0,format=yuv420p`,
    "-c:v",
    "libx264",
    "-crf",
    "20",
    out
  )
  return out
}
