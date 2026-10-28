/** What a change of a track's value means, per unit: one table, so every consumer agrees. */

interface UnitScale {
  /** Measurement noise: a measured wobble below this is not a turning point. */
  readonly noise: number
  /** The least travel that counts as motion; anything smaller is noise or a rounding step. */
  readonly minTravel: number
}

const SCALES: Readonly<Record<string, UnitScale>> = {
  px: { noise: 0.5, minTravel: 2 },
  "0..1": { noise: 0.01, minTravel: 0.02 },
  ratio: { noise: 0.01, minTravel: 0.02 },
  levels: { noise: 0.5, minTravel: 2 }
}

/** Units this table does not know are treated as exact: any change is motion. */
const EXACT: UnitScale = { noise: 0, minTravel: Number.MIN_VALUE }

export const unitScale = (unit: string): UnitScale => SCALES[unit] ?? EXACT
