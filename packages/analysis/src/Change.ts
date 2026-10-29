/**
 * Visible change inside a fixed box, frame by frame: what `track` reports as `change`, and the
 * numbers under each `frames` diff. The box is a place on screen, not a subject to follow, so an
 * element fading or sliding into it is measured where it ends up.
 */
import {
  type FrameIndex,
  type FrameRef,
  InvalidInput,
  type KymoError,
  type Size,
  type Source,
  type Track,
  frameIndex
} from "@kymo/core"
import { Effect, Stream } from "effect"
import { type Gray, toGray } from "./Pixels.ts"
import type { FrameRange } from "./Range.ts"
import { noiseLevelOf } from "./Signals.ts"
import { round } from "./Stats.ts"
import type { Box } from "./Tracker.ts"
import {
  type Inner,
  type Patch,
  type Rule,
  VISIBLE_STEP,
  patchLevels,
  isVisible,
  subpixelEdge,
  visibleChange
} from "./Visible.ts"

/**
 * The box is read with its long edge at this many pixels (never above the source's): fine enough to
 * see a pixel of the box's own movement, coarse enough that encoder noise averages out.
 */
const WORK_EDGE = 128

/** The ring around the box is this share of the box's short side, and at least `MIN_MARGIN` pixels. */
const MARGIN_SHARE = 0.25
const MIN_MARGIN = 4

/** A box and its ring, cut from one frame. */
export interface Cut {
  readonly patch: Patch
  readonly inner: Inner
}

/** The long edge to decode at so `box` is read at `WORK_EDGE`. */
export const workEdge = (size: Size, box: Box): number =>
  Math.max(
    16,
    Math.round(Math.max(size.width, size.height) * Math.min(0.5, WORK_EDGE / Math.max(box.w, box.h)))
  )

/**
 * Cut `rect` (in `image` pixels) and a ring around it out of `image`. The same rect on two frames of
 * one size gives two patches that compare pixel for pixel.
 */
export const cutPatch = (
  image: { readonly width: number; readonly height: number; readonly data: ArrayLike<number> },
  rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
): Cut => {
  const clampX = (v: number) => Math.max(0, Math.min(image.width, v))
  const clampY = (v: number) => Math.max(0, Math.min(image.height, v))
  const bx0 = clampX(Math.floor(rect.x))
  const by0 = clampY(Math.floor(rect.y))
  const bx1 = Math.max(bx0 + 1, clampX(Math.ceil(rect.x + rect.w)))
  const by1 = Math.max(by0 + 1, clampY(Math.ceil(rect.y + rect.h)))
  const m = Math.max(MIN_MARGIN, Math.round(MARGIN_SHARE * Math.min(bx1 - bx0, by1 - by0)))
  const px0 = clampX(bx0 - m)
  const py0 = clampY(by0 - m)
  const px1 = clampX(bx1 + m)
  const py1 = clampY(by1 + m)
  const width = px1 - px0
  const height = py1 - py0
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data[y * width + x] = image.data[(py0 + y) * image.width + px0 + x]!
  return {
    patch: { width, height, data },
    inner: {
      x0: bx0 - px0,
      y0: by0 - py0,
      x1: Math.min(width, bx1 - px0),
      y1: Math.min(height, by1 - py0)
    }
  }
}

/** A cut of `box` (source pixels) from a frame decoded at any size, and that size's scale. */
const cutBox = (gray: Gray, size: Size, box: Box): Cut & { readonly scale: number } => {
  const sx = gray.width / size.width
  const sy = gray.height / size.height
  return {
    ...cutPatch(gray, { x: box.x * sx, y: box.y * sy, w: box.w * sx, h: box.h * sy }),
    scale: Math.min(sx, sy)
  }
}

/** The source's frame size; only sources with pixels have change to measure. */
const sizeOf = (source: Source): Effect.Effect<Size, InvalidInput> =>
  source.timeline.size === null
    ? Effect.fail(
        new InvalidInput({
          message: `${source.timeline.handle} has no pixels to measure change on.`,
          hint: "Measure change on a video, image sequence or synthetic scene."
        })
      )
    : Effect.succeed(source.timeline.size)

/** One frame's change from the frame before it, inside the box. */
export interface FrameChange {
  readonly index: FrameIndex
  /** Fraction of the box's pixels that visibly changed, 0..1. */
  readonly changedFraction: number
  /** Mean luma change of those pixels, 0..1; 0 when none changed. */
  readonly changedMean: number
  /** Whether that is a visible change: a short edge and more than 0.1% of the box. */
  readonly visible: boolean
  /** A dim or brighten of the whole page around the box was taken out of it. */
  readonly discounted: boolean
}

const frameChange = (index: FrameIndex, ref: Cut, cur: Cut, rule: Rule): FrameChange => {
  const v = visibleChange(ref.patch, cur.patch, cur.inner, rule)
  return {
    index,
    changedFraction: round(v.changed / v.total, 4),
    changedMean: v.changed === 0 ? 0 : round(v.sum / v.changed / 255, 4),
    visible: isVisible(v),
    discounted: v.discounted
  }
}

/** The rule for a set of consecutive pairs: their own noise, never below what is visible. */
const ruleOf = (pairs: ReadonlyArray<readonly [Cut, Cut]>, scale: number): Rule => ({
  floor: Math.max(
    VISIBLE_STEP,
    noiseLevelOf(
      pairs.flatMap(([a, b]) => {
        const { box, ring } = patchLevels(a.patch, b.patch, b.inner)
        return ring === undefined ? [box] : [box, ring]
      })
    )
  ),
  edge: subpixelEdge(scale)
})

/** A run of frames, both ends included. */
export interface Span {
  readonly from: FrameRef
  readonly to: FrameRef
}

export interface BoxChange {
  readonly box: Box
  /** Luma steps (0..255) a pixel had to change by to count. */
  readonly floor: number
  /** Every frame of the range that has a frame before it, in order. */
  readonly frames: ReadonlyArray<FrameChange>
  /** `<name>.change`: each frame's `changedFraction`, null where there is no frame before it or outside the range. */
  readonly track: Track
  /** Runs of frames that visibly changed from the frame before them. */
  readonly changing: ReadonlyArray<Span>
  /** Runs of frames where a dim or brighten of the page around the box was taken out of its change. */
  readonly discounted: ReadonlyArray<Span>
  /** The first frame that visibly differs from the range's first frame. */
  readonly starts: FrameRef | undefined
  /**
   * The first frame from which every frame looks like the range's last one: where the box reaches
   * its final look. Undefined when the last frame still visibly differs from the one before it.
   */
  readonly settles: FrameRef | undefined
}

/** Runs of consecutive frames that satisfy `test`. */
const runs = (
  range: FrameRange,
  frames: ReadonlyArray<FrameChange>,
  test: (f: FrameChange) => boolean
): Array<Span> => {
  const out: Array<Span> = []
  for (let k = 0; k < frames.length; k++) {
    if (!test(frames[k]!)) continue
    const start = k
    while (k + 1 < frames.length && test(frames[k + 1]!) && frames[k + 1]!.index === frames[k]!.index + 1) k++
    out.push({ from: range.ref(frames[start]!.index), to: range.ref(frames[k]!.index) })
  }
  return out
}

/**
 * Visible change inside `box` (source pixels, fixed on screen) over `range`. Decodes the range once
 * (and the frame before it), at a size chosen from the box, keeping only the box and its ring.
 */
export const boxChange = (
  source: Source,
  range: FrameRange,
  box: Box,
  name = "box"
): Effect.Effect<BoxChange, KymoError> =>
  Effect.gen(function* () {
    const size = yield* sizeOf(source)
    const from = Math.max(0, range.first - 1)
    const indices = Array.from({ length: range.last - from + 1 }, (_, k) => frameIndex(from + k))
    const cuts: Array<{ readonly index: FrameIndex; readonly cut: Cut; readonly scale: number }> = []
    yield* Stream.runForEach(source.readFrames(indices, { maxEdge: workEdge(size, box) }), (frame) =>
      Effect.sync(() => {
        const c = cutBox(toGray(frame.image), size, box)
        cuts.push({ index: frame.index, cut: c, scale: c.scale })
      })
    )
    const scale = cuts[0]!.scale
    const pairs = cuts.slice(1).map((c, k) => [cuts[k]!.cut, c.cut] as const)
    const rule = ruleOf(pairs, scale)
    const frames = cuts.slice(1).map((c, k) => frameChange(c.index, cuts[k]!.cut, c.cut, rule))
    const inRange = cuts.filter((c) => c.index >= range.first)
    const first = inRange[0]!.cut
    const last = inRange[inRange.length - 1]!.cut
    const differs = (a: Cut, b: Cut) => isVisible(visibleChange(a.patch, b.patch, b.inner, rule))
    const startAt = inRange.findIndex((c) => differs(first, c.cut))
    const stillAtEnd = frames.length === 0 || !frames[frames.length - 1]!.visible
    let settleAt = inRange.length - 1
    while (settleAt > 0 && !differs(inRange[settleAt - 1]!.cut, last)) settleAt--
    const inside = frames.filter((f) => f.index >= range.first)
    const samples: Array<number | null> = Array.from({ length: range.frameCount }, () => null)
    for (const f of inside) samples[f.index] = f.changedFraction
    return {
      box,
      floor: rule.floor,
      frames: inside,
      track: { name: `${name}.change`, unit: "0..1", samples },
      changing: runs(range, inside, (f) => f.visible),
      discounted: runs(range, inside, (f) => f.discounted),
      starts: startAt < 0 ? undefined : range.ref(inRange[startAt]!.index),
      settles: stillAtEnd ? range.ref(inRange[settleAt]!.index) : undefined
    }
  })

/**
 * Each frame's visible change from the frame before it, inside `box` or over the whole frame, for
 * frames that need not be consecutive. The noise floor comes from these pairs alone.
 */
export const pairChanges = (
  source: Source,
  indices: ReadonlyArray<FrameIndex>,
  box: Box
): Effect.Effect<{ readonly floor: number; readonly frames: ReadonlyArray<FrameChange> }, KymoError> =>
  Effect.gen(function* () {
    const size = yield* sizeOf(source)
    const wanted = [...new Set(indices.flatMap((i) => [i - 1, i]))]
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)
      .map(frameIndex)
    const byIndex = new Map<number, Cut & { readonly scale: number }>()
    yield* Stream.runForEach(source.readFrames(wanted, { maxEdge: workEdge(size, box) }), (frame) =>
      Effect.sync(() => {
        byIndex.set(frame.index, cutBox(toGray(frame.image), size, box))
      })
    )
    const pairs = indices.flatMap((i) => {
      const a = byIndex.get(i - 1)
      const b = byIndex.get(i)
      return a && b ? [[a, b] as const] : []
    })
    const scale = byIndex.values().next().value?.scale ?? 1
    const rule = ruleOf(pairs, scale)
    const frames = indices.flatMap((i) => {
      const a = byIndex.get(i - 1)
      const b = byIndex.get(i)
      return a && b ? [frameChange(i, a, b, rule)] : []
    })
    return { floor: rule.floor, frames }
  })
