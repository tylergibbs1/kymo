import { Timeline } from "@kymo/core"
import { Workspace } from "@kymo/sources"
import { Effect, Schema } from "effect"
import { As, Replace } from "../Fields.ts"
import { define } from "../Operation.ts"

export const OpenInput = Schema.Struct({
  src: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "A video path, a directory of numbered images, or a synthetic:<scene>?… spec."
  }),
  as: Schema.optionalKey(As),
  replace: Schema.optionalKey(Replace),
  offset: Schema.optionalKey(
    Schema.Int.annotate({
      description:
        "Frames this source runs late against the sources it is compared with: with offset 6, its frame 6 shows what an unshifted source shows at 0f. Negative when it runs early. compare pairs frames through it; 0 clears it."
    })
  )
}).annotate({ identifier: "OpenInput" })

export const OpenOutput = Schema.Struct({
  handle: Schema.String,
  input: Schema.String,
  offset: Schema.Int.annotate({ description: "The offset now stored for this handle." }),
  timeline: Timeline
}).annotate({ identifier: "OpenOutput" })

export const open = define({
  name: "open",
  title: "Name a source",
  description:
    "Name a source with a short handle (remembered in .kymo/handles.json), so later commands can say clip1 or hero instead of a path. Opens it once to check it can be read.",
  cost: "no images",
  examples: [{ src: "clips/launch.mp4" }, { src: "synthetic:bounce?impact=20", as: "ball" }],
  input: OpenInput,
  output: OpenOutput,
  readOnly: false,
  run: Effect.fn("kymo.open")(function* (input: typeof OpenInput.Type) {
    const workspace = yield* Workspace
    const handle = yield* workspace.register(input.src, input.as, { replace: input.replace === true })
    if (input.offset !== undefined) yield* workspace.setOffset(handle, input.offset)
    const source = yield* workspace.open(handle)
    return { handle, input: input.src, offset: source.timeline.offset ?? 0, timeline: source.timeline }
  }, Effect.scoped)
})
