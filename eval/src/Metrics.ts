/** What a task run cost: images, visual tokens, API tokens, calls, errors and time. */
import { visualTokens } from "@kymo/layout"
import { Effect } from "effect"
import sharp from "sharp"
import type { Usage } from "./Model.ts"
import type { Block } from "./Tools.ts"

export interface Metrics {
  readonly imagesSent: number
  /** ⌈w/28⌉ × ⌈h/28⌉ per image sent to the model. */
  readonly visualTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly toolCalls: number
  readonly toolErrors: number
  /** Calls to a tool whose previous call returned an error. */
  readonly retries: number
  readonly wallMs: number
}

export const emptyMetrics: Metrics = {
  imagesSent: 0,
  visualTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  toolErrors: 0,
  retries: 0,
  wallMs: 0
}

/** Pixel size of a base64 image (PNG, JPEG, WebP, GIF). Undecodable images count as zero tokens. */
export const imageSize = (data: string): Effect.Effect<{ readonly width: number; readonly height: number }> =>
  Effect.promise(() =>
    sharp(Buffer.from(data, "base64"))
      .metadata()
      .then((m) => ({ width: m.width ?? 0, height: m.height ?? 0 }))
      .catch(() => ({ width: 0, height: 0 }))
  )

/** Images and visual tokens in a set of result blocks. */
export const imageCost = (
  blocks: ReadonlyArray<Block>
): Effect.Effect<{ readonly images: number; readonly tokens: number }> =>
  Effect.map(
    Effect.forEach(
      blocks.flatMap((b) => (b._tag === "image" ? [b.data] : [])),
      imageSize
    ),
    (sizes) => ({
      images: sizes.length,
      tokens: sizes.reduce((sum, s) => sum + (s.width > 0 ? visualTokens(s.width, s.height) : 0), 0)
    })
  )

export const addUsage = (m: Metrics, u: Usage): Metrics => ({
  ...m,
  inputTokens: m.inputTokens + u.inputTokens,
  outputTokens: m.outputTokens + u.outputTokens
})
