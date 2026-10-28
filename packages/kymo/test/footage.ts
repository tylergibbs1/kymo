import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
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

/** A detailed, non-repeating texture (Perlin noise at high contrast), so differences saturate as on film. */
const texture = (seed: number, width: number, fps: number) =>
  `perlin=size=${width}x270:rate=${fps}:octaves=6:persistence=0.8:xscale=6:yscale=6:tscale=0:random_mode=seed:random_seed=${seed},eq=contrast=2.5`

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
        "-f",
        "lavfi",
        "-i",
        texture(spec.seed ?? 1, width, spec.fps),
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
