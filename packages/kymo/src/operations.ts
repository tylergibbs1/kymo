import type { AnyOperation } from "./Operation.ts"
import { check } from "./ops/Check.ts"
import { compare } from "./ops/Compare.ts"
import { frames } from "./ops/Frames.ts"
import { open } from "./ops/Open.ts"
import { probe } from "./ops/Probe.ts"
import { record } from "./ops/Record.ts"
import { scan } from "./ops/Scan.ts"
import { track } from "./ops/Track.ts"

/** The operations every shell exposes: MCP tools `kymo_<name>`, and CLI commands. */
export const toolOperations = [
  probe,
  scan,
  frames,
  compare,
  track,
  check,
  record
] as const satisfies ReadonlyArray<AnyOperation>

/** Every operation, including CLI-only ones. */
export const operations = [open, ...toolOperations] as const satisfies ReadonlyArray<AnyOperation>
