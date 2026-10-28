import { Timeline } from "@kymo/core"
import { Workspace } from "@kymo/sources"
import { Effect, Schema } from "effect"
import { As, Replace, Source } from "../Fields.ts"
import { define } from "../Operation.ts"

export const ProbeInput = Schema.Struct({
  source: Source,
  as: Schema.optionalKey(As),
  replace: Schema.optionalKey(Replace)
}).annotate({
  identifier: "ProbeInput"
})

export const ProbeOutput = Timeline.annotate({
  identifier: "ProbeOutput",
  description: "The source's Timeline: its handle, clock, length, size, numeric tracks and markers."
})

export const probe = define({
  name: "probe",
  title: "Describe a source",
  description:
    "Open a source and describe its Timeline: handle, fps, frame count, duration, size, numeric tracks and markers. Cheap and returns no images; call it first on anything new. Returns a handle (clip1, or the name you give with as) you can pass as `source` afterwards.",
  cost: "no images",
  examples: [
    { source: "synthetic:bounce?impact=20" },
    { source: "clips/launch.mp4", as: "launch" },
    { source: "clip1" }
  ],
  input: ProbeInput,
  output: ProbeOutput,
  readOnly: true,
  run: Effect.fn("kymo.probe")(function* (input: typeof ProbeInput.Type) {
    const workspace = yield* Workspace
    const source = yield* workspace.open(input.source)
    if (input.as === undefined) return source.timeline
    // Name the input as the workspace records it (not the Timeline's normalised form), so an existing
    // handle can be renamed as well as a path named, and naming a source as itself changes nothing.
    const { input: recorded } = yield* workspace.resolve(input.source)
    const handle = yield* workspace.register(recorded, input.as, { replace: input.replace === true })
    return (yield* workspace.open(handle)).timeline
  }, Effect.scoped)
})
