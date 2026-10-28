/**
 * Capturing UI scenes in a real browser. For each frame: seek every animation to `i / fps` seconds,
 * let the page paint, record each tracked element's box and opacity, and screenshot it. The frames
 * are encoded to H.264 at the case's quality. Footage lands in `<cache>/ui/<key>/clip.mp4`, next to
 * the full truth; it is never committed. Rendering is deterministic: animations are paused and
 * seeked, never played.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Schema } from "effect"
import { type Browser, chromium } from "playwright"
import {
  type CaptureSpec,
  CaptureTruth,
  FOOTAGE_FILE,
  SCENES_DIR,
  VIEWPORT,
  captureDir,
  captureKey,
  compact,
  queryOf
} from "./Truth.ts"

export class CaptureFailed extends Schema.TaggedError<CaptureFailed>()("CaptureFailed", {
  key: Schema.String,
  message: Schema.String
}) {}

interface SceneInfo {
  readonly fps: number
  readonly frames: number
  readonly width: number
  readonly height: number
}

/** The page's globals, as scene.js defines them. Read through `globalThis`: eval has no DOM types. */
interface ScenePage {
  readonly SCENE: SceneInfo & {
    render(i: number): void
    truth(i: number): Record<string, number>
  }
  requestAnimationFrame(callback: () => void): number
}

const captureOne = async (
  browser: Browser,
  spec: CaptureSpec,
  dir: string,
  key: string
): Promise<CaptureTruth> => {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  try {
    const url = `${pathToFileURL(join(SCENES_DIR, `${spec.scene}.html`)).href}?${queryOf(spec)}`
    const errors: Array<string> = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.goto(url)
    await page.waitForFunction(() => "SCENE" in globalThis)
    if (errors.length > 0) throw new Error(errors.join("; "))
    const info = await page.evaluate(() => {
      const { fps, frames, width, height } = (globalThis as unknown as ScenePage).SCENE
      return { fps, frames, width, height }
    })
    const frames = join(dir, "frames")
    mkdirSync(frames, { recursive: true })
    const rows: Array<Record<string, number>> = []
    for (let i = 0; i < info.frames; i++) {
      await page.evaluate((i) => (globalThis as unknown as ScenePage).SCENE.render(i), i)
      // Two animation frames: style, layout and paint have all caught up with the seek.
      await page.evaluate(() => {
        const g = globalThis as unknown as ScenePage
        return new Promise((done) => g.requestAnimationFrame(() => g.requestAnimationFrame(() => done(null))))
      })
      rows.push(await page.evaluate((i) => (globalThis as unknown as ScenePage).SCENE.truth(i), i))
      await page.screenshot({ path: join(frames, `${String(i).padStart(5, "0")}.png`), animations: "allow" })
    }
    execFileSync("ffmpeg", [
      ...["-y", "-loglevel", "error", "-framerate", String(info.fps)],
      ...["-i", join(frames, "%05d.png")],
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(spec.crf), "-preset", "medium"],
      join(dir, FOOTAGE_FILE)
    ])
    rmSync(frames, { recursive: true, force: true })
    return {
      key,
      scene: spec.scene,
      query: queryOf(spec),
      crf: spec.crf,
      ...info,
      tracks: compact(rows)
    }
  } finally {
    await page.close()
  }
}

/**
 * Capture every spec not already cached, and return the truth of all of them, in spec order.
 * A cached capture is reused as is: its key covers the scene files and parameters.
 */
export const captureAll = (
  specs: ReadonlyArray<CaptureSpec>,
  cacheDir: string,
  progress: (line: string) => void
): Effect.Effect<ReadonlyArray<CaptureTruth>, CaptureFailed> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => chromium.launch(),
      catch: (e) =>
        new CaptureFailed({
          key: "-",
          message: `Could not start Chromium (${e instanceof Error ? e.message : String(e)}). Run \`npx playwright install chromium\`.`
        })
    }),
    (browser) =>
      Effect.forEach(specs, (spec, n) =>
        Effect.tryPromise({
          try: async () => {
            const key = captureKey(spec)
            const dir = captureDir(cacheDir, key)
            const truthPath = join(dir, "truth.json")
            if (existsSync(join(dir, ".complete"))) {
              progress(`[${n + 1}/${specs.length}] ${spec.scene}?${queryOf(spec)}: cached`)
              return Schema.decodeUnknownSync(CaptureTruth)(JSON.parse(readFileSync(truthPath, "utf8")))
            }
            const partial = `${dir}.partial-${process.pid}`
            rmSync(partial, { recursive: true, force: true })
            mkdirSync(partial, { recursive: true })
            const truth = await captureOne(browser, spec, partial, key)
            writeFileSync(join(partial, "truth.json"), JSON.stringify(Schema.encodeSync(CaptureTruth)(truth)))
            writeFileSync(join(partial, ".complete"), "")
            rmSync(dir, { recursive: true, force: true })
            renameSync(partial, dir)
            progress(`[${n + 1}/${specs.length}] ${spec.scene}?${queryOf(spec)}: ${truth.frames} frames`)
            return truth
          },
          catch: (e) =>
            new CaptureFailed({ key: captureKey(spec), message: e instanceof Error ? e.message : String(e) })
        })
      ),
    (browser) => Effect.promise(() => browser.close())
  )
