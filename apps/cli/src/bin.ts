import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { run } from "./Cli.ts"

NodeRuntime.runMain(
  Effect.flatMap(run(process.argv.slice(2)), (code) =>
    Effect.sync(() => {
      process.exitCode = code
    })
  ),
  { disableErrorReporting: true }
)
