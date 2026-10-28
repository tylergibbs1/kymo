import { NodeServices } from "@effect/platform-node"
import { Address } from "@kymo/core"
import { Sources, Workspace } from "@kymo/sources"
import { Layer } from "effect"
import { FrameLabels } from "./FrameLabels.ts"
import { OutputDir } from "./OutputDir.ts"

export interface LiveOptions {
  /** Where images go. Default: a fresh `kymo-*` temp directory per process. */
  readonly out?: string | undefined
  /** Where `.kymo/handles.json` lives. Default: the current directory. */
  readonly root?: string | undefined
  /** How frames are labelled on images and in sheet labels. Default: `08s10f #250`. */
  readonly labelStyle?: Address.LabelStyle | undefined
}

/** Everything operations need, wired for Node: sources, the workspace of handles, the output directory and labels. */
export const kymoLayer = (
  options: LiveOptions = {}
): Layer.Layer<Workspace | OutputDir | FrameLabels | NodeServices.NodeServices> =>
  Layer.mergeAll(
    (options.root === undefined ? Workspace.layer : Workspace.layerAt(options.root)).pipe(
      Layer.provide(Sources.layer)
    ),
    OutputDir.layer(options.out),
    FrameLabels.layer(options.labelStyle ?? Address.DEFAULT_LABEL_STYLE),
    NodeServices.layer
  )

/** `Effect.provide(KymoLive)` to run any operation from a library. */
export const KymoLive = kymoLayer()
