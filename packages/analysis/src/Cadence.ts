/**
 * A pattern that recurs at a fixed period: the same positions within every `period` frames carry an
 * event (a repeated frame, a skipped frame). Frame-rate conversion leaves exactly this: 24 fps shown at
 * 60 repeats 3 of every 5 frames, 25 fps shown at 24 skips 1 of every 24.
 */
export interface Cadence {
  readonly period: number
  /** Events in each period. */
  readonly perPeriod: number
  /** Scan positions of the events in the pattern, in order. */
  readonly events: ReadonlyArray<number>
}

/** A pattern needs this many events, over at least this many periods, to be a cadence. */
const MIN_EVENTS = 6
const MIN_PERIODS = 4
/** Each position of the pattern carries an event on at least this share of the frames where one could be seen. */
const MIN_HIT_RATE = 0.6
/** The pattern ends after this many periods in a row with no event where one could have been seen. */
const MAX_MISSED_PERIODS = 3
/** The positions of the pattern are read from this many periods after its first event. */
const PROBE_PERIODS = 6
/** At most this share of the events in a cadence's span may fall outside it (stray repeats, say). */
const MAX_STRAYS = 0.1

/** Once a clip shows one event every `period` frames, this many events whole periods apart elsewhere are the same cadence. */
const MIN_CHAIN = 3

const residue = (k: number, period: number) => ((k % period) + period) % period

/** The positions within `period` that carry events in the `PROBE_PERIODS` periods from `start`. */
const probe = (isEvent: ReadonlyArray<boolean>, start: number, period: number): Set<number> | undefined => {
  const counts = new Map<number, number>()
  for (let k = start; k < Math.min(isEvent.length, start + PROBE_PERIODS * period); k++)
    if (isEvent[k]) counts.set(residue(k, period), (counts.get(residue(k, period)) ?? 0) + 1)
  const pattern = new Set([...counts].filter(([, n]) => n >= 2).map(([r]) => r))
  return pattern.size === 0 || pattern.size >= period || !pattern.has(residue(start, period))
    ? undefined
    : pattern
}

/**
 * The pattern with this period starting at event `start`: which positions carry events, and how far it
 * holds. It holds through frames where nothing could be seen (`known` false, e.g. a still shot) and
 * through a phase slip (the same pattern, shifted, as when a conversion drifts or a shot is cut). It
 * ends after `MAX_MISSED_PERIODS` periods of expected events that did not come, or when events out of
 * pattern are no longer rare.
 */
const follow = (
  isEvent: ReadonlyArray<boolean>,
  known: ReadonlyArray<boolean>,
  start: number,
  period: number
): Cadence | undefined => {
  let pattern = probe(isEvent, start, period)
  if (pattern === undefined) return undefined
  const events: Array<number> = []
  // Misses count only up to the last event: the pattern's end is not a miss.
  let misses = 0
  let missesInSpan = 0
  let missedInRow = 0
  let strays = 0
  for (let k = start; k < isEvent.length; k++) {
    if (isEvent[k] && !pattern.has(residue(k, period))) {
      const slipped = probe(isEvent, k, period)
      if (slipped !== undefined && slipped.size === pattern.size) pattern = slipped
      else if (++strays > MAX_STRAYS * Math.max(events.length, 1 / MAX_STRAYS)) break
      else continue
    }
    if (isEvent[k]) {
      events.push(k)
      missedInRow = 0
      missesInSpan = misses
    } else if (pattern.has(residue(k, period)) && known[k]) {
      misses++
      if (++missedInRow > MAX_MISSED_PERIODS * pattern.size) break
    }
  }
  const span = events[events.length - 1]! - events[0]! + 1
  if (events.length < MIN_EVENTS || span < MIN_PERIODS * period) return undefined
  if (events.length < MIN_HIT_RATE * (events.length + missesInSpan)) return undefined
  return { period, perPeriod: pattern.size, events }
}

/**
 * One cadence, cut into stretches by shots where it could not be seen or where its phase drifted, is
 * still one cadence. Merge stretches of the same pattern in time order, taking in the unclaimed events
 * between them that are no denser than the pattern (at most `perPeriod` in any `period` frames), when
 * the rest are rare. Events taken in are claimed in `free`.
 */
const merge = (stretches: ReadonlyArray<Cadence>, free: Array<boolean>): Array<Cadence> => {
  const out: Array<Cadence> = []
  for (const c of stretches) {
    const prev = out[out.length - 1]
    if (prev !== undefined) {
      const between: Array<number> = []
      let strays = 0
      for (let k = prev.events[prev.events.length - 1]! + 1; k < c.events[0]!; k++) {
        if (!free[k]) continue
        if (between.filter((e) => e > k - c.period).length < c.perPeriod) between.push(k)
        else strays++
      }
      const events = [...prev.events, ...between, ...c.events]
      if (strays <= MAX_STRAYS * events.length) {
        for (const e of between) free[e] = false
        out[out.length - 1] = { ...prev, events }
        continue
      }
    }
    out.push(c)
  }
  return out
}

/**
 * Regular cadences among events, shortest period first; events in none of them are irregular.
 * `known[k]` says an event could have been seen at k (the picture moved there), so frames where it
 * could not neither confirm nor break a pattern.
 */
export const cadences = (
  isEvent: ReadonlyArray<boolean>,
  known: ReadonlyArray<boolean>,
  maxPeriod: number
): Array<Cadence> => {
  const free = [...isEvent]
  const found: Array<Cadence> = []
  for (let period = 2; period <= maxPeriod; period++) {
    for (let k = 0; k < free.length; k++) {
      if (!free[k]) continue
      const c = follow(free, known, k, period)
      if (c === undefined) continue
      found.push(c)
      for (const e of c.events) free[e] = false
      k = c.events[c.events.length - 1]!
    }
  }
  const byPattern = new Map<string, Array<Cadence>>()
  for (const c of found) {
    const key = `${c.period}/${c.perPeriod}`
    byPattern.set(key, [...(byPattern.get(key) ?? []), c])
  }
  const merged = [...byPattern.values()].flatMap((same) => merge(same, free))
  // The longest cadences take in chains first.
  return merged
    .sort((a, b) => b.events.length - a.events.length)
    .map((c) => takeInChains(c, free))
    .sort((a, b) => a.events[0]! - b.events[0]!)
}

/**
 * A conversion runs through the whole clip, but where the picture barely moves (a fade, a slow shot)
 * only some of its events show, too few for a cadence on their own. Once the clip shows one event every
 * `period` frames, unclaimed events in chains of at least `MIN_CHAIN`, each a whole number of periods
 * (at most `MAX_MISSED_PERIODS`) after the one before, belong to it. Lone events stay out.
 */
const takeInChains = (c: Cadence, free: Array<boolean>): Cadence => {
  if (c.perPeriod !== 1) return c
  const taken: Array<number> = []
  let chain: Array<number> = []
  const close = () => {
    if (chain.length >= MIN_CHAIN) taken.push(...chain)
    chain = []
  }
  for (let k = 0; k < free.length; k++) {
    if (!free[k]) continue
    const last = chain[chain.length - 1]
    if (last !== undefined && ((k - last) % c.period !== 0 || k - last > MAX_MISSED_PERIODS * c.period))
      close()
    chain.push(k)
  }
  close()
  for (const e of taken) free[e] = false
  return taken.length === 0 ? c : { ...c, events: [...c.events, ...taken].sort((a, b) => a - b) }
}
