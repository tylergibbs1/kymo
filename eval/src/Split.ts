import { createHash } from "node:crypto"
import type { Split } from "./Task.ts"

/** Share of tasks in the dev split. The rest are held out and only scored, never tuned against. */
export const DEV_SHARE = 0.7

/**
 * The split for a task id: a pure function of the id, so adding or removing other tasks never moves
 * a task between dev and heldout.
 */
export const splitOf = (id: string): Split => {
  const bucket = createHash("sha256").update(id).digest().readUInt32BE(0) / 2 ** 32
  return bucket < DEV_SHARE ? "dev" : "heldout"
}
