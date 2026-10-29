import {
  type FrameIndex,
  FrameRef,
  InvalidInput,
  type KymoError,
  type Size,
  type Source,
  Track,
  frameIndex
} from "@kymo/core"
import { Effect, Result, Schema, Stream } from "effect"
import { cutPatch } from "./Change.ts"
import { type Pose, type Template, cutTemplate, score, search } from "./Match.ts"
import { type Plane, planeOf, pyramid } from "./Plane.ts"
import type { FrameRange } from "./Range.ts"
import { round } from "./Stats.ts"
import { VISIBLE_STEP, anyMovement, visibleChange } from "./Visible.ts"

const Positive = Schema.Finite.check(Schema.isGreaterThan(0))

/** An axis-aligned box in source pixels. */
export const Box = Schema.Struct({ x: Schema.Finite, y: Schema.Finite, w: Positive, h: Positive })
export type Box = typeof Box.Type

const BOX_EXAMPLE = "x,y,w,h in source pixels, e.g. 120,80,64,64"

/** Parse `x,y,w,h` and check the box lies inside a frame of `size`. */
export const parseBox = (text: string, size: Size): Result.Result<Box, InvalidInput> => {
  const parts = text.split(",").map((p) => p.trim())
  const nums = parts.map(Number)
  if (parts.length !== 4 || parts.some((p) => p === "") || nums.some((n) => !Number.isFinite(n))) {
    return Result.fail(
      new InvalidInput({ message: `"${text}" is not a box.`, hint: `Write ${BOX_EXAMPLE}.` })
    )
  }
  const [x, y, w, h] = nums as [number, number, number, number]
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > size.width || y + h > size.height) {
    return Result.fail(
      new InvalidInput({
        message: `Box ${text} is not inside the ${size.width}x${size.height} frame.`,
        hint: `Use a box with positive size inside 0,0,${size.width},${size.height}; ${BOX_EXAMPLE}.`
      })
    )
  }
  return Result.succeed({ x, y, w, h })
}

/**
 * Why a run of frames has no position. `low-confidence`: something is there but it does not match
 * the subject. `edge`: the subject is (almost) entirely outside the frame. `faded`: nothing with the
 * subject's structure is where it was, as when it fades out or is hidden.
 */
export const LostReason = Schema.Literals(["low-confidence", "edge", "faded"])
export type LostReason = typeof LostReason.Type

/** Consecutive frames where the region was lost, for the same reason as its first frame. */
export const LostSpan = Schema.Struct({ from: FrameRef, to: FrameRef, reason: LostReason })
export type LostSpan = typeof LostSpan.Type

/**
 * A region followed over time, as four px Tracks named `<name>.x`, `.y`, `.w`, `.h`.
 * Template matching and (later) DOM selectors both produce this shape.
 */
export const RegionTrack = Schema.Struct({
  /** The region's name and track prefix: `box`, or a selector such as `#hero`. */
  name: Schema.String,
  method: Schema.Literals(["template", "selector"]),
  from: FrameRef,
  to: FrameRef,
  /** The frame the box was given at; tracking runs forwards and backwards from it. */
  anchor: Schema.optionalKey(FrameRef),
  x: Track,
  y: Track,
  /** Measured: the box scales with the subject (about its centre). */
  w: Track,
  h: Track,
  /** Match quality per frame, 0..1. Position samples are null where the region was lost. */
  confidence: Track,
  /**
   * `<name>.opacity`: how much of its contrast at the anchor frame the subject shows (1 at the
   * anchor), measured where it is, or where it was last seen when it faded out. Null where it was
   * lost past the frame edge or to something unlike it.
   */
  opacity: Track,
  /** Where position samples are null, and why; in frame order. */
  lost: Schema.Array(LostSpan)
})
export type RegionTrack = typeof RegionTrack.Type

export interface TrackOptions {
  /** Track prefix. Default `box`. */
  readonly name?: string
  /** Long edge to decode at. Default: chosen from the box size, so cost does not grow with the box. */
  readonly maxEdge?: number
  /** The frame `box` describes, inside `range`. Default `range.first`. */
  readonly anchor?: number
}

/** Below this match quality (ZNCC) the region counts as lost for that frame. */
const LOST = 0.5
/** After a loss, a match must be at least this good to pick the region up again. */
const RECOVER = 0.6
/** A match further than `Model.near` from the predicted position must be at least this good. */
const JUMP = 0.8
/** Less of the template than this inside the frame cannot be matched. */
const MIN_VISIBLE = 0.12
/** A lost subject with less than this much of its template inside the frame has left it. */
const EDGE_VISIBLE = 0.5
/** A lost subject whose spot shows less than this fraction of its contrast has faded out. */
const FADED_CONTRAST = 0.2
/** Scale is fitted only while this much of the template is inside the frame. */
const SCALE_VISIBLE = 0.95
/** The box's long edge at the working resolution: enough for sub-pixel precision, cheap to search. */
const WORK_EDGE = 192
/** The coarsest search level keeps the template's short side at least this many pixels. */
const COARSE_SIDE = 8
/** A template whose variance (grey levels², per pixel) is below this is flat: it is matched with a margin of its surroundings, so its edges carry the match. */
const FLAT_TEMPLATE = 9
/** Working pixels of surroundings kept around the box in the template. */
const MARGIN = 2
/** Frames decoded at once when tracking backwards. */
const BACKWARD_CHUNK = 32

interface Model {
  readonly templates: ReadonlyArray<Template>
  readonly levels: number
  /** Working pixels per source pixel. */
  readonly sx: number
  readonly sy: number
  /** Search radius around the last position, level-0 pixels. */
  readonly radius: number
  /** How far (level-0 pixels) a match may land from the prediction and still count as expected. */
  readonly near: number
}

interface State {
  pose: Pose
  /** The frame `pose` was measured on: a frame that does not visibly differ from it keeps the pose. */
  held: Plane | undefined
  vx: number
  vy: number
  /** Frames since the last match; 0 while matched. */
  missed: number
  /** Why the current run of misses began; a run keeps the reason of its first frame. */
  reason: LostReason | undefined
}

type Step =
  | { readonly _tag: "found"; readonly pose: Pose; readonly q: number; readonly gain: number }
  | {
      readonly _tag: "lost"
      readonly q: number
      readonly reason: LostReason
      /** The subject's contrast where it was last seen, when it faded there; else unknown. */
      readonly gain: number | null
    }

/** The subject's box at `pose`, in level-0 pixels. */
const rectAt = (model: Model, box: Box, pose: Pose) => {
  const w = pose.s * box.w * model.sx
  const h = pose.s * box.h * model.sy
  return { x: pose.cx - w / 2, y: pose.cy - h / 2, w, h }
}

/**
 * Whether the subject's box looks the same as on the frame its pose was measured on. Then it has
 * not moved, and measuring again would only turn encoder noise into sub-pixel jitter.
 */
const unchanged = (model: Model, box: Box, held: Plane, plane: Plane, pose: Pose): boolean => {
  const rect = rectAt(model, box, pose)
  const before = cutPatch(held, rect)
  const now = cutPatch(plane, rect)
  // Any change beyond noise is evidence of movement here, however small: the tracker resolves it.
  const rule = { floor: VISIBLE_STEP, edge: 0 }
  return !anyMovement(visibleChange(before.patch, now.patch, now.inner, rule))
}

const step = (model: Model, state: State, levels: ReadonlyArray<Plane>): Step => {
  const { pose, vx, vy, missed } = state
  const ahead = missed + 1
  const px = pose.cx + vx * ahead
  const py = pose.cy + vy * ahead
  // Search around the last position, widened by speed (so stopping and reversing stay inside) and
  // by every frame without a match; the prediction breaks ties.
  const grow = model.radius * Math.min(missed, 3)
  const rx = model.radius + Math.abs(vx) + grow
  const ry = model.radius + Math.abs(vy) + grow
  const found = search(
    levels,
    model.templates,
    {
      x0: Math.min(pose.cx, px) - rx,
      x1: Math.max(pose.cx, px) + rx,
      y0: Math.min(pose.cy, py) - ry,
      y1: Math.max(pose.cy, py) + ry,
      px,
      py
    },
    pose.s,
    MIN_VISIBLE,
    true
  )
  // A match far from where the subject should be must be convincing: a faint or vanished subject
  // otherwise "matches" whatever background structure is nearby.
  const off = found === undefined ? 0 : Math.hypot(found.pose.cx - px, found.pose.cy - py)
  const near = model.near + 0.5 * Math.hypot(vx, vy)
  const need = Math.max(missed > 0 ? RECOVER : LOST, off > near ? JUMP : 0)
  if (found !== undefined && found.score.q >= need) {
    const s = found.score.visible >= SCALE_VISIBLE ? found.pose.s : pose.s
    const next = { cx: found.pose.cx, cy: found.pose.cy, s }
    state.vx = (next.cx - pose.cx) / ahead
    state.vy = (next.cy - pose.cy) / ahead
    state.pose = next
    state.held = levels[0]
    state.missed = 0
    state.reason = undefined
    const at = s === found.pose.s ? found.score : score(levels[0]!, model.templates[0]!, next)
    return { _tag: "found", pose: next, q: found.score.q, gain: at.gain }
  }
  state.missed = missed + 1
  state.held = undefined
  state.reason ??= lostReason(model, levels[0]!, pose, { cx: px, cy: py, s: pose.s })
  return {
    _tag: "lost",
    q: found?.score.q ?? 0,
    reason: state.reason,
    gain: state.reason === "faded" ? score(levels[0]!, model.templates[0]!, pose).gain : null
  }
}

/**
 * Why the subject was not found: it is past the frame edge at its predicted position, nothing with
 * its contrast is where it was last seen (it faded or was hidden), or something unlike it is there.
 */
const lostReason = (model: Model, plane: Plane, last: Pose, predicted: Pose): LostReason => {
  const t = model.templates[0]!
  if (score(plane, t, predicted).visible < EDGE_VISIBLE) return "edge"
  // A template with no structure of its own (a box on plain background) cannot tell a fade apart.
  if (t.variance < FLAT_TEMPLATE) return "low-confidence"
  return score(plane, t, last).contrast < FADED_CONTRAST ? "faded" : "low-confidence"
}

/** The template at every level, cut around the box on the anchor frame. */
const modelOf = (base: Plane, box: Box, size: Size): { model: Model; start: Pose } => {
  const sx = base.width / size.width
  const sy = base.height / size.height
  const cx = (box.x + box.w / 2) * sx
  const cy = (box.y + box.h / 2) * sy
  let tw = Math.max(2, Math.round(box.w * sx))
  let th = Math.max(2, Math.round(box.h * sy))
  // The subject's own edges carry most of the match (and all of its scale), so the template keeps a
  // thin margin of surroundings; a flat subject gets a wider one, as its edges are all it has.
  const pad =
    cutTemplate(base, cx, cy, tw, th).variance < FLAT_TEMPLATE
      ? Math.max(2, Math.round(0.2 * Math.min(tw, th)))
      : MARGIN
  tw += 2 * pad
  th += 2 * pad
  let levels = 1
  while (levels < 6 && Math.min(tw, th) / 2 ** levels >= COARSE_SIDE) levels++
  const planes = pyramid(base, levels)
  const templates = planes.map((p, k) =>
    cutTemplate(
      p,
      cx / 2 ** k,
      cy / 2 ** k,
      Math.max(2, Math.round(tw / 2 ** k)),
      Math.max(2, Math.round(th / 2 ** k))
    )
  )
  return {
    model: {
      templates,
      levels,
      sx,
      sy,
      radius: Math.max(6, 0.5 * Math.max(tw, th)),
      near: Math.max(3, 0.15 * Math.max(tw, th))
    },
    start: { cx, cy, s: 1 }
  }
}

/** Runs of lost frames, each with the reason of its first frame. */
const lostSpans = (range: FrameRange, reasons: ReadonlyArray<LostReason | undefined>): Array<LostSpan> => {
  const out: Array<LostSpan> = []
  for (let i = range.first; i <= range.last; i++) {
    const reason = reasons[i]
    if (reason === undefined) continue
    const start = i
    while (i + 1 <= range.last && reasons[i + 1] === reason) i++
    out.push({ from: range.ref(start), to: range.ref(i), reason })
  }
  return out
}

const span = (from: number, to: number): Array<FrameIndex> =>
  from > to ? [] : Array.from({ length: to - from + 1 }, (_, k) => frameIndex(from + k))

/**
 * Follow `box` (source px, as it is at the anchor frame) through `range`, forwards and backwards
 * from the anchor: ZNCC template matching, coarse to fine on an image pyramid, with sub-pixel
 * position and scale. A lost region is searched for around its predicted path and picked up again.
 */
export const trackRegion = (
  source: Source,
  range: FrameRange,
  box: Box,
  options: TrackOptions = {}
): Effect.Effect<RegionTrack, KymoError> =>
  Effect.gen(function* () {
    const name = options.name ?? "box"
    const size = source.timeline.size
    if (size === null) {
      return yield* Effect.fail(
        new InvalidInput({
          message: `${source.timeline.handle} has no pixels to track.`,
          hint: "Track a region on a video, image sequence or web source; telemetry has tracks already."
        })
      )
    }
    const anchor = options.anchor ?? range.first
    if (anchor < range.first || anchor > range.last) {
      return yield* Effect.fail(
        new InvalidInput({
          message: `The anchor frame #${anchor} is outside ${range.spanText(range.first, range.last)}.`,
          hint: `Give the box at a frame inside the range, e.g. #${range.first}.`
        })
      )
    }
    const longEdge = Math.max(size.width, size.height)
    const maxEdge =
      options.maxEdge ?? Math.max(16, Math.round(longEdge * Math.min(1, WORK_EDGE / Math.max(box.w, box.h))))
    const read = (indices: ReadonlyArray<FrameIndex>) =>
      Stream.runCollect(source.readFrames(indices, { maxEdge }))

    const nulls = () => Array.from({ length: range.frameCount }, (): number | null => null)
    const xs = nulls()
    const ys = nulls()
    const ws = nulls()
    const hs = nulls()
    const qs = nulls()
    const os = nulls()
    const reasons: Array<LostReason | undefined> = Array.from({ length: range.frameCount }, () => undefined)

    const [first] = yield* read([frameIndex(anchor)])
    const { model, start } = modelOf(planeOf(first!.image), box, size)
    const record = (index: number, pose: Pose, q: number, gain: number) => {
      xs[index] = round(pose.cx / model.sx - (pose.s * box.w) / 2, 2)
      ys[index] = round(pose.cy / model.sy - (pose.s * box.h) / 2, 2)
      ws[index] = round(pose.s * box.w, 2)
      hs[index] = round(pose.s * box.h, 2)
      qs[index] = round(q, 3)
      os[index] = round(Math.max(0, gain), 2)
    }
    xs[anchor] = round(box.x, 2)
    ys[anchor] = round(box.y, 2)
    ws[anchor] = round(box.w, 2)
    hs[anchor] = round(box.h, 2)
    qs[anchor] = 1
    os[anchor] = 1

    const follow = (state: State, index: number, base: Plane) => {
      if (state.held !== undefined && unchanged(model, box, state.held, base, state.pose)) {
        // Still: the pose stands (if the subject is still recognisably there), and its speed is spent.
        const at = score(base, model.templates[0]!, state.pose)
        if (at.q >= LOST) {
          state.vx = 0
          state.vy = 0
          record(index, state.pose, at.q, at.gain)
          return
        }
      }
      const r = step(model, state, pyramid(base, model.levels))
      if (r._tag === "found") record(index, r.pose, r.q, r.gain)
      else {
        qs[index] = round(r.q, 3)
        os[index] = r.gain === null ? null : round(Math.max(0, r.gain), 2)
        reasons[index] = r.reason
      }
    }

    const anchorPlane = planeOf(first!.image)
    const forward: State = { pose: start, held: anchorPlane, vx: 0, vy: 0, missed: 0, reason: undefined }
    yield* Stream.runForEach(source.readFrames(span(anchor + 1, range.last), { maxEdge }), (frame) =>
      Effect.sync(() => follow(forward, frame.index, planeOf(frame.image)))
    )
    // Backwards: decode a chunk in order (video decodes forwards), then follow it in reverse.
    const backward: State = { pose: start, held: anchorPlane, vx: 0, vy: 0, missed: 0, reason: undefined }
    for (let end = anchor - 1; end >= range.first; end -= BACKWARD_CHUNK) {
      const frames = yield* read(span(Math.max(range.first, end - BACKWARD_CHUNK + 1), end))
      const planes = frames.map((f) => ({ index: f.index, plane: planeOf(f.image) }))
      for (let k = planes.length - 1; k >= 0; k--) follow(backward, planes[k]!.index, planes[k]!.plane)
    }

    return {
      name,
      method: "template" as const,
      from: range.ref(range.first),
      to: range.ref(range.last),
      anchor: range.ref(anchor),
      x: { name: `${name}.x`, unit: "px", samples: xs },
      y: { name: `${name}.y`, unit: "px", samples: ys },
      w: { name: `${name}.w`, unit: "px", samples: ws },
      h: { name: `${name}.h`, unit: "px", samples: hs },
      confidence: { name: `${name}.confidence`, unit: "0..1", samples: qs },
      opacity: { name: `${name}.opacity`, unit: "ratio", samples: os },
      lost: lostSpans(range, reasons)
    }
  })
