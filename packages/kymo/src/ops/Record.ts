import { AdapterUnavailable, Timeline } from "@kymo/core"
import { Effect, Schema } from "effect"
import { Source } from "../Fields.ts"
import { define } from "../Operation.ts"

export const RecordInput = Schema.Struct({
  source: Source.annotate({
    description: "A live source to record, such as a screen, window, camera or URL."
  }),
  duration: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "How long to record, as a span like 5s or 02s15f."
  }),
  as: Schema.optionalKey(Schema.String.annotate({ description: "Handle for the recording, e.g. take1." }))
}).annotate({ identifier: "RecordInput" })

export const RecordOutput = Timeline.annotate({
  identifier: "RecordOutput",
  description: "The recording's Timeline, frozen to a file and opened under its handle."
})

export const record = define({
  name: "record",
  title: "Record a live source",
  description:
    "Record a live source (screen, window, camera, page) for a duration and freeze it to a file you can scan, track and check like any video. Not available in this release: freeze the motion to a file yourself (e.g. a screen recording) and pass its path to probe instead.",
  cost: "no images",
  examples: [
    { source: "screen", duration: "5s" },
    { source: "http://localhost:3000", duration: "3s", as: "take1" }
  ],
  input: RecordInput,
  output: RecordOutput,
  readOnly: false,
  run: Effect.fn("kymo.record")(function* (_input: typeof RecordInput.Type) {
    return yield* new AdapterUnavailable({
      message: "Live recording arrives in a later release; freeze a file and open it instead.",
      hint: "Record the screen or page to an .mp4 or .mov with any recorder, then pass its path as source to probe."
    })
  })
})
