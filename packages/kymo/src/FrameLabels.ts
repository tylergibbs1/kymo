import { Address } from "@kymo/core"
import { Context, Layer } from "effect"

/**
 * How operations name frames on images, in sheet labels, and in messages, reasons and notes. JSON
 * `address`/`index` fields never change.
 */
export class FrameLabels extends Context.Service<FrameLabels, { readonly style: Address.LabelStyle }>()(
  "kymo/FrameLabels"
) {
  static readonly layer = (style: Address.LabelStyle): Layer.Layer<FrameLabels> =>
    Layer.succeed(FrameLabels)(FrameLabels.of({ style }))
}
