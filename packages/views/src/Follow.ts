import { Address, type FrameIndex, InvalidInput, type KymoError, type Source } from "@kymo/core"
import { type Target, paginate } from "@kymo/layout"
import { Effect, Schema } from "effect"
import type { ViewResult } from "./Output.ts"
import type { Paging } from "./Sheet.ts"
import {
  checkFrames,
  fileSafe,
  frameLabel,
  frameRef,
  frameSize,
  readFrames,
  spanOf
} from "./internal/Frames.ts"
import { writePages } from "./internal/Pages.ts"
import { pixelGrid } from "./internal/PixelGrid.ts"
import { type PixelRect, crop } from "./internal/Pixels.ts"
import { label } from "./internal/Svg.ts"

const Px = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Extent = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * The region to follow, in source pixels. `Fixed` is one box for every frame; `Tracked` is a
 * box of fixed size centred each frame on the values of two tracks (e.g. an object's x and y).
 */
export const FollowBox = Schema.Union([
  Schema.TaggedStruct("Fixed", { x: Px, y: Px, width: Extent, height: Extent }),
  Schema.TaggedStruct("Tracked", { x: Schema.String, y: Schema.String, width: Extent, height: Extent })
])
export type FollowBox = typeof FollowBox.Type

export interface FollowOptions extends Paging {
  readonly source: Source
  readonly frames: ReadonlyArray<FrameIndex>
  readonly box: FollowBox
  readonly outDir: string
  readonly target: Target
  /** Overlay source-pixel coordinates on each crop. */
  readonly pixelGrid?: boolean
}

const boxName = (box: FollowBox): string =>
  box._tag === "Fixed"
    ? `${box.x}-${box.y}-${box.width}x${box.height}`
    : `${fileSafe(box.x)}-${fileSafe(box.y)}-${box.width}x${box.height}`

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * A box cropped from each frame, as a sheet of crops at no more than source resolution.
 * Written as `<span>.follow.<box>.png`.
 */
export const follow = Effect.fn("follow")(function* (
  o: FollowOptions
): Effect.fn.Return<ViewResult, KymoError> {
  const { timeline } = o.source
  const { box } = o
  yield* checkFrames(o.source, o.frames)
  const size = yield* frameSize(o.source)
  const outside =
    box.width > size.width ||
    box.height > size.height ||
    (box._tag === "Fixed" && (box.x + box.width > size.width || box.y + box.height > size.height))
  if (outside)
    return yield* new InvalidInput({
      message: `The ${box.width}x${box.height} box does not fit inside ${timeline.handle}'s ${size.width}x${size.height} frame.`,
      hint: "Use a box within the frame; coordinates are source pixels from the top-left."
    })
  const regions: ReadonlyArray<PixelRect> =
    box._tag === "Fixed"
      ? o.frames.map(() => box)
      : yield* Effect.gen(function* () {
          const xs = yield* o.source.track(box.x)
          const ys = yield* o.source.track(box.y)
          return yield* Effect.forEach(o.frames, (i) => {
            const cx = xs.samples[i]
            const cy = ys.samples[i]
            if (cx === undefined || cx === null || cy === undefined || cy === null)
              return Effect.fail(
                new InvalidInput({
                  message: `Tracks ${box.x}/${box.y} have no position at ${Address.label(timeline.rate, i)}.`,
                  hint: "Follow only frames where the object is tracked, or use a Fixed box."
                })
              )
            return Effect.succeed({
              x: clamp(Math.round(cx - box.width / 2), 0, size.width - box.width),
              y: clamp(Math.round(cy - box.height / 2), 0, size.height - box.height),
              width: box.width,
              height: box.height
            })
          })
        })
  const items = o.frames.map((index, k) => ({ index, region: regions[k]! }))
  const pages = yield* Effect.fromResult(
    paginate({
      items: items.length,
      frame: { width: box.width, height: box.height },
      target: o.target,
      labelChars: Math.max(...o.frames.map((i) => frameLabel(timeline, i, false).length)),
      cursor: o.cursor,
      maxSheets: o.maxSheets
    })
  )
  const destination = {
    view: "follow",
    outDir: o.outDir,
    fileName: (span: string) => `${span}.follow.${boxName(box)}.png`
  } as const
  return yield* writePages(destination, pages, items, (plan, page) => {
    // Decode just large enough that the box comes out at the planned cell size.
    const scale = plan.frame.width / box.width
    const maxEdge = Math.max(1, Math.round(Math.max(size.width, size.height) * scale))
    const indices = page.map((p) => p.index)
    return Effect.map(readFrames(o.source, indices, maxEdge), (decoded) => ({
      span: spanOf(timeline, indices),
      frames: decoded.map((f) => frameRef(timeline, f)),
      drawing: {
        width: plan.width,
        height: plan.height,
        tiles: decoded.map((f, k) => {
          const s = f.image.width / size.width
          const r = page[k]!.region
          const x = clamp(Math.round(r.x * s), 0, f.image.width - 1)
          const y = clamp(Math.round(r.y * s), 0, f.image.height - 1)
          const region = {
            x,
            y,
            width: clamp(Math.round(r.width * s), 1, f.image.width - x),
            height: clamp(Math.round(r.height * s), 1, f.image.height - y)
          }
          return { image: crop(f.image, region), rect: plan.cells[k]!.frame }
        }),
        overlay: plan.cells
          .map(
            (cell, k) =>
              label(cell.label, frameLabel(timeline, indices[k]!, false)) +
              (o.pixelGrid ? pixelGrid(cell.frame, page[k]!.region) : "")
          )
          .join("")
      }
    }))
  })
})
