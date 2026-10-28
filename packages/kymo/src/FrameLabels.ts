import { Address } from "@kymo/core"
import { Context, Layer } from "effect"

/** How operations label frames on images and in sheet labels. JSON `address`/`index` never change. */
export class FrameLabels extends Context.Service<FrameLabels, { readonly style: Address.LabelStyle }>()(
  "kymo/FrameLabels"
) {
  static readonly layer = (style: Address.LabelStyle): Layer.Layer<FrameLabels> =>
    Layer.succeed(FrameLabels)(FrameLabels.of({ style }))
}
