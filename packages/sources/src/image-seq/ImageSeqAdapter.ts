import { NodeServices } from "@effect/platform-node"
import {
  BackendFailure,
  InvalidInput,
  type Rate,
  type RateFrom,
  RgbImage,
  type Size,
  SourceNotFound
} from "@kymo/core"
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import sharp from "sharp"
import { frameSource, type RegisteredAdapter } from "../Adapter.ts"
import { RateParam, decodeParams, parseRational, splitQuery } from "../Params.ts"
import { makeTimeline } from "../Timeline.ts"

/** Directories carry no timing, so their frames play at this rate unless `?fps=` says otherwise. */
export const DEFAULT_SEQUENCE_FPS = 30

const ANIMATED = /\.(gif|webp)$/i
const STILL = /\.(png|jpe?g)$/i
/** Browsers show GIF frames with a delay this short (or none) for 100 ms; so do we. */
const MIN_DELAY_MS = 20

const Params = Schema.Struct({ fps: Schema.optionalKey(RateParam) })
const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare

const decodeFailed = (file: string, cause: unknown) =>
  new BackendFailure({
    message: `Could not decode ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
    hint: "Check the image is a complete PNG, JPG, GIF or WebP."
  })

const decodeImage = (file: string, page: number | undefined, target: Size) =>
  Effect.tryPromise({
    try: () =>
      sharp(file, page === undefined ? {} : { page, pages: 1 })
        .flatten({ background: "#000000" })
        .toColourspace("srgb")
        .resize(target.width, target.height, { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer(),
    catch: (cause) => decodeFailed(file, cause)
  }).pipe(Effect.map((buf) => RgbImage.make(target.width, target.height, new Uint8Array(buf))))

const metadata = (file: string) =>
  Effect.tryPromise({
    try: () => sharp(file, { animated: true }).metadata(),
    catch: (cause) => decodeFailed(file, cause)
  })

/** How frames are laid out on the clock. */
type Timing =
  | { readonly _tag: "Constant"; readonly rate: Rate }
  | {
      readonly _tag: "Delays"
      readonly rate: Rate
      readonly starts: ReadonlyArray<number>
      readonly total: number
    }

/** Timing from per-frame delays: constant if they are all equal, otherwise variable. */
const timingFromDelays = (delaysMs: ReadonlyArray<number>): Timing => {
  const delays = delaysMs.map((d) => (d < MIN_DELAY_MS ? 100 : d))
  const total = delays.reduce((a, b) => a + b, 0)
  if (delays.every((d) => d === delays[0])) {
    return { _tag: "Constant", rate: parseRational(`${1000}/${delays[0]}`)! }
  }
  let elapsed = 0
  const starts = delays.map((d) => {
    const start = elapsed / 1000
    elapsed += d
    return start
  })
  return {
    _tag: "Delays",
    rate: parseRational(`${1000 * delays.length}/${total}`)!,
    starts,
    total: total / 1000
  }
}

/**
 * A directory of PNG/JPG frames (natural sort order), or an animated GIF/WebP. Timing comes from
 * `?fps=`, else the animation's own frame delays, else 30 fps for directories.
 */
export class ImageSeqAdapter extends Context.Service<ImageSeqAdapter, RegisteredAdapter>()(
  "@kymo/sources/ImageSeqAdapter"
) {
  static readonly layerNoDeps = Layer.effect(ImageSeqAdapter)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      /** What a sequence is made of: one entry per frame, its size, its clock, and the input as recorded. */
      interface Layout {
        readonly frames: ReadonlyArray<{ readonly file: string; readonly page: number | undefined }>
        readonly size: Size
        readonly timing: Timing
        readonly rateFrom: RateFrom
        readonly input: string
      }

      const directory = Effect.fnUntraced(function* (input: string, dir: string, fps: Rate | undefined) {
        const names = (yield* fs.readDirectory(dir).pipe(Effect.mapError((e) => decodeFailed(dir, e))))
          .filter((n) => STILL.test(n))
          .sort(naturalOrder)
        if (names.length === 0) {
          return yield* new InvalidInput({
            message: `${dir} has no PNG or JPG files.`,
            hint: "Point at a directory of numbered frames like frame_001.png, or at a video file."
          })
        }
        const frames = names.map((n) => ({ file: path.join(dir, n), page: undefined }))
        const meta = yield* metadata(frames[0]!.file)
        return {
          frames,
          size: { width: meta.width, height: meta.height },
          timing: { _tag: "Constant", rate: fps ?? { num: DEFAULT_SEQUENCE_FPS, den: 1 } },
          rateFrom: fps ? "param" : "assumed",
          input: fps ? input : `${input}?fps=${DEFAULT_SEQUENCE_FPS}`
        } satisfies Layout
      })

      const animation = Effect.fnUntraced(function* (input: string, file: string, fps: Rate | undefined) {
        const meta = yield* metadata(file)
        const pages = meta.pages ?? 1
        return {
          frames: Array.from({ length: pages }, (_, page) => ({ file, page })),
          size: { width: meta.width, height: meta.pageHeight ?? meta.height },
          timing: fps
            ? { _tag: "Constant", rate: fps }
            : timingFromDelays(Array.from({ length: pages }, (_, i) => meta.delay?.[i] ?? 100)),
          rateFrom: fps ? "param" : "source",
          input
        } satisfies Layout
      })

      const open = Effect.fnUntraced(function* (input: string, handle: string) {
        const { path: target, params } = yield* Effect.fromResult(splitQuery(input))
        const { fps } = yield* Effect.fromResult(decodeParams(Params, params, target))
        const info = yield* fs.stat(target).pipe(
          Effect.mapError(
            () =>
              new SourceNotFound({
                message: `No file or directory at ${target}.`,
                hint: "Pass a directory of PNG/JPG frames or a .gif/.webp file, optionally with ?fps=24."
              })
          )
        )
        if (info.type !== "Directory" && !ANIMATED.test(target)) {
          return yield* new InvalidInput({
            message: `${target} is not a directory, GIF or WebP.`,
            hint: "Image sequences are a directory of PNG/JPG frames or an animated .gif/.webp."
          })
        }
        const {
          frames,
          size,
          timing,
          rateFrom,
          input: recordedInput
        }: Layout = info.type === "Directory"
          ? yield* directory(input, target, fps)
          : yield* animation(input, target, fps)

        const timeline = makeTimeline({
          handle,
          kind: "image-seq",
          input: recordedInput,
          rate: timing.rate,
          rateFrom,
          frameCount: frames.length,
          size,
          ...(timing._tag === "Delays" ? { clock: { starts: timing.starts, end: timing.total } } : {})
        })
        return frameSource({
          timeline,
          tracks: [],
          decode: (i, target) => decodeImage(frames[i]!.file, frames[i]!.page, target),
          concurrency: 4
        })
      })

      return ImageSeqAdapter.of({
        kind: "image-seq",
        accepts: "a directory of PNG/JPG frames, or an animated .gif/.webp (add ?fps=24 to set the rate)",
        claims: (input) => {
          const target = input.split("?")[0]!
          if (/^[A-Za-z][\w+.-]*:/.test(target)) return false
          const last =
            target
              .split("/")
              .filter((s) => s.length > 0)
              .pop() ?? target
          return ANIMATED.test(target) || target.endsWith("/") || !last.includes(".")
        },
        open
      })
    })
  )

  static readonly layer = ImageSeqAdapter.layerNoDeps.pipe(Layer.provide(NodeServices.layer))
}
