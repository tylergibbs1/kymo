/** Side of one vision tile in pixels: an image costs one visual token per started 28×28 tile. */
export const TOKEN_TILE_PX = 28

/** Visual tokens an image of this size costs, so cost is known before anything is rendered. */
export const visualTokens = (width: number, height: number): number =>
  Math.ceil(width / TOKEN_TILE_PX) * Math.ceil(height / TOKEN_TILE_PX)
