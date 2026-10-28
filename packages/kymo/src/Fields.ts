/** Input fields shared by several operations. Each is defined once and described for agents. */
import { FRAME_CAP } from "@kymo/core"
import {
  Cursor as LayoutCursor,
  MAX_TARGET_EDGE,
  MIN_TARGET_EDGE,
  MIN_TARGET_TOKENS,
  Target
} from "@kymo/layout"
import { Effect, Schema, SchemaTransformation } from "effect"

export const Source = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "What to look at: a video path (clip.mp4), a directory of numbered images, a synthetic:<scene>?… spec, or a handle from an earlier call (clip1)."
})

/** The handle to give a source; shared by every operation that can name one, so they accept it alike. */
export const As = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The handle to use for this source, e.g. hero. Default: the next free clipN."
})

export const Address = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "A frame address: 08s10f, #250, 8.33s, -1f, @impact+5f, or a range 2s..4s:2f."
})

export const Addresses = Schema.Array(Address).check(Schema.isMinLength(1)).annotate({
  description:
    'Frame addresses, e.g. ["0f", "08s10f", "-1f"]. A range like 2s..4s:5f adds every frame it names.'
})

/** A contiguous range for analysis (no step). */
export const Range = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "A contiguous range like 2s..4s, #30..#90 or @cut1..-1f. Default: the whole source."
})

/** A range for drawing frames: a step is allowed. */
export const SteppedRange = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "A range like 2s..4s, or with a step 0f..-1f:10f. Default: every frame (subject to the 100-frame cap)."
})

const CustomBudget = Schema.Struct({
  maxEdge: Schema.Int.check(
    Schema.isBetween({ minimum: MIN_TARGET_EDGE, maximum: MAX_TARGET_EDGE })
  ).annotate({
    description: "Longest image side in pixels."
  }),
  maxTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_TARGET_TOKENS)).annotate({
    description: "Visual tokens per image (one per started 28x28 tile)."
  })
})

type TargetEncoded = (typeof Target)["Encoded"]

/**
 * Where images will be viewed. `high-res` (≤2576 px, ≤4784 visual tokens), `standard` (≤1568 px,
 * ≤1568 tokens), or a custom `{maxEdge, maxTokens}`. Decodes to the layout `Target`.
 */
export const TargetInput = Schema.Union([Schema.Literals(["high-res", "standard"]), CustomBudget])
  .annotate({
    description:
      'Image budget: "high-res" (default; ≤2576 px, ≤4784 visual tokens per image), "standard" (≤1568 px, ≤1568 tokens) for older model tiers, or a custom {maxEdge, maxTokens}.'
  })
  .pipe(
    Schema.decodeTo(
      Target,
      SchemaTransformation.transform({
        decode: (t): TargetEncoded =>
          typeof t === "string"
            ? { _tag: t }
            : { _tag: "custom", maxEdge: t.maxEdge, maxTokens: t.maxTokens },
        encode: (t: TargetEncoded) =>
          t._tag === "custom" ? { maxEdge: t.maxEdge, maxTokens: t.maxTokens } : t._tag
      })
    ),
    Schema.withDecodingDefaultKey(Effect.succeed("high-res" as const))
  )

export const Format = Schema.Literals(["concise", "detailed"])
  .annotate({
    description:
      "concise (default): addresses and paths. detailed: adds times, image sizes and token costs, track values and markers."
  })
  .pipe(Schema.withDecodingDefaultKey(Effect.succeed("concise" as const)))
export type Format = "concise" | "detailed"

export const Cursor = LayoutCursor.annotate({
  description: "The `next` value from the previous result of the same call, to get the following sheets."
})

export const Uncapped = Schema.Boolean.annotate({
  description: `Allow more than ${FRAME_CAP} frames in one request. Costs grow with every sheet; prefer a step or sample=motion.`
})

/** A box in source pixels, `x,y,w,h`, as typed on a command line and in hints. */
export const BoxText = Schema.String.check(
  Schema.isPattern(/^\s*-?\d+(\.\d+)?\s*(,\s*-?\d+(\.\d+)?\s*){3}$/, {
    expected: "a box x,y,w,h like 120,80,64,64"
  })
).annotate({ description: "A box in source pixels from the top-left: x,y,w,h, e.g. 120,80,64,64." })
