import { Timeline } from "@kymo/core"
import { Workspace } from "@kymo/sources"
import { Effect, Schema } from "effect"
import { Source } from "../Fields.ts"
import { define } from "../Operation.ts"

export const ProbeInput = Schema.Struct({ source: Source }).annotate({ identifier: "ProbeInput" })

export const ProbeOutput = Timeline.annotate({
  identifier: "ProbeOutput",
  description: "The source's Timeline: its handle, clock, length, size, numeric tracks and markers."
})

export const probe = define({
  name: "probe",
  title: "Describe a source",
  description:
    "Open a source and describe its Timeline: handle, fps, frame count, duration, size, numeric tracks and markers. Cheap and returns no images; call it first on anything new. Returns a handle (clip1) you can pass as `source` afterwards.",
  cost: "no images",
  examples: [{ source: "synthetic:bounce?impact=20" }, { source: "clips/launch.mp4" }, { source: "clip1" }],
  input: ProbeInput,
  output: ProbeOutput,
  readOnly: true,
  run: Effect.fn("kymo.probe")(function* (input: typeof ProbeInput.Type) {
    const workspace = yield* Workspace
    const source = yield* workspace.open(input.source)
    return source.timeline
  }, Effect.scoped)
})
