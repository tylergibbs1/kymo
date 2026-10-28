/** Saving what scan found as markers on the source, under names that never change once given. */
import type { Cuts, Motion } from "@kymo/analysis"
import type { KymoError, Marker } from "@kymo/core"
import { Workspace } from "@kymo/sources"
import { Effect } from "effect"

/**
 * Save the cuts and motion peaks of a scan and return them under their saved names. Detection
 * numbers what it finds within the range it saw (`cut1` is the first cut in range); the workspace
 * keeps one name per frame across scans, so a ranged scan reuses `@cut4` instead of renaming it.
 */
export const saveScanMarkers = (
  handle: string,
  cuts: Cuts,
  motion: Motion
): Effect.Effect<{ readonly cuts: Cuts; readonly motion: Motion }, KymoError, Workspace> =>
  Effect.gen(function* () {
    const workspace = yield* Workspace
    const names = yield* workspace.saveDetected(handle, [
      ...cuts.cuts.map((c) => ({ kind: "cut" as const, index: c.marker.index })),
      ...motion.peaks.map((p) => ({ kind: "peak" as const, index: p.marker.index }))
    ])
    const named = (marker: Marker, k: number): Marker => ({ ...marker, name: names[k]! })
    return {
      cuts: { ...cuts, cuts: cuts.cuts.map((c, k) => ({ ...c, marker: named(c.marker, k) })) },
      motion: {
        ...motion,
        peaks: motion.peaks.map((p, k) => ({ ...p, marker: named(p.marker, cuts.cuts.length + k) }))
      }
    }
  })
