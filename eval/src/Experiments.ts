/**
 * Every A/B the spec's experiment checklist asks for, in one place. A variant is a server config +
 * pinned tool arguments; everything else (tasks, model, call limit) is held fixed by the runner, so
 * the only difference between arms is what is written here.
 *
 * Pins are checked against the server's published schemas at startup (Pin.ts). Server switches are
 * the server's own `ServerConfig`, started with `toEnv`, so a switch the server does not read cannot
 * be written here.
 */
import { DEFAULT_SERVER_CONFIG, type ServerConfig } from "kymo"
import type { JsonObject } from "./Tools.ts"

export interface Variant {
  readonly name: string
  /** The full config the server runs with: defaults plus what the variant sets. */
  readonly config: ServerConfig
  readonly pin: Readonly<Record<string, JsonObject>>
}

export interface Experiment {
  readonly name: string
  /** The decision this experiment informs. */
  readonly question: string
  readonly variants: readonly [Variant, ...Array<Variant>]
}

interface VariantParts {
  readonly config?: Partial<ServerConfig>
  readonly pin?: Variant["pin"]
}

const variant = (name: string, parts: VariantParts = {}): Variant => ({
  name,
  config: { ...DEFAULT_SERVER_CONFIG, ...parts.config },
  pin: parts.pin ?? {}
})

const VIEW_TOOLS = ["kymo_scan", "kymo_frames", "kymo_compare"] as const
const pinAll = (tools: ReadonlyArray<string>, args: JsonObject) =>
  Object.fromEntries(tools.map((t) => [t, args]))

export const EXPERIMENTS: ReadonlyArray<Experiment> = [
  {
    name: "baseline",
    question: "How does the server do with its defaults?",
    variants: [variant("default")]
  },
  {
    name: "target",
    question: "Do high-res sheets buy accuracy worth their visual tokens over standard?",
    variants: [
      variant("high-res", { pin: pinAll(VIEW_TOOLS, { target: "high-res" }) }),
      variant("standard", { pin: pinAll(VIEW_TOOLS, { target: "standard" }) })
    ]
  },
  {
    name: "cells",
    question: "How many cells per scan sheet: 4, 9 or 12?",
    variants: [
      variant("cells-4", { pin: { kymo_scan: { budget: 4 } } }),
      variant("cells-9", { pin: { kymo_scan: { budget: 9 } } }),
      variant("cells-12", { pin: { kymo_scan: { budget: 12 } } })
    ]
  },
  {
    name: "label-style",
    question: "Which frame label do models quote back most accurately?",
    variants: [
      variant("timecode+index", { config: { labelStyle: "both" } }),
      variant("timecode", { config: { labelStyle: "timecode" } }),
      variant("index", { config: { labelStyle: "index" } })
    ]
  },
  {
    name: "onion-vs-sheet",
    question: "Is an onion-skin view better than a sheet for reading motion and easing?",
    variants: [
      variant("sheet", { pin: { kymo_frames: { view: "sheet" } } }),
      variant("onion", { pin: { kymo_frames: { view: "onion" } } })
    ]
  },
  {
    name: "sampling",
    question: "Does motion-adaptive sampling beat even sampling at the same budget?",
    variants: [
      variant("even", { pin: { kymo_scan: { sample: "even" } } }),
      variant("motion", { pin: { kymo_scan: { sample: "motion" } } })
    ]
  },
  {
    name: "tool-examples",
    question: "Do worked examples in tool descriptions reduce errors and calls?",
    variants: [
      variant("examples-on", { config: { toolExamples: "on" } }),
      variant("examples-off", { config: { toolExamples: "off" } })
    ]
  },
  {
    name: "text-fallback",
    question: "Is the text fallback next to structuredContent better as JSON or Markdown?",
    variants: [
      variant("json", { config: { textFormat: "json" } }),
      variant("markdown", { config: { textFormat: "markdown" } })
    ]
  }
]

export const experimentNamed = (name: string): Experiment | undefined =>
  EXPERIMENTS.find((e) => e.name === name)
