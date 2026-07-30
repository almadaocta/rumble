/**
 * The power-curve arithmetic: rolling-window bests over a stream, and the merge
 * rule for folding one activity's bests into an athlete's records.
 *
 * Separate from power-bests.ts, which is the persistence half. These functions
 * take arrays and return numbers — nothing here needs a database, and keeping
 * them apart means their tests don't reach for one either.
 */
export const DURATIONS = {
  best1s: 1,
  best3s: 3,
  best10s: 10,
  best30s: 30,
  best1min: 60,
  best5min: 300,
  best10min: 600,
  best15min: 900,
  best20min: 1200,
  best30min: 1800,
  best1hr: 3600,
  best2hr: 7200,
} as const;

export type BestsMap = Record<keyof typeof DURATIONS, number | null>;

/**
 * All twelve durations, empty.
 *
 * Derived from DURATIONS, but adding a duration is not a single edit: the
 * twelve buckets are also spelled out as columns on the personalBests table and
 * again in athlete.controller.ts's powerBests mapping. A new one needs all
 * three, plus a migration.
 */
export function emptyBests(): BestsMap {
  return Object.fromEntries(Object.keys(DURATIONS).map((k) => [k, null])) as BestsMap;
}

/** Picks just the duration keys off a wider row (e.g. a personalBests record). */
export function bestsFrom(source: Partial<BestsMap>): BestsMap {
  return Object.fromEntries(
    Object.keys(DURATIONS).map((k) => [k, source[k as keyof BestsMap] ?? null]),
  ) as BestsMap;
}

export function computeBestsFromPower(power: number[]): BestsMap {
  const result = emptyBests();

  // No `!power` check: the parameter is number[] and every caller passes
  // `power ?? []`, so the only real case is an empty stream.
  if (power.length === 0) return result;

  for (const [key, window] of Object.entries(DURATIONS)) {
    if (power.length < window) continue;

    let sum = 0;
    for (let i = 0; i < window; i++) sum += (power[i] ?? 0);
    let best = sum / window;

    for (let i = window; i < power.length; i++) {
      sum += (power[i] ?? 0) - (power[i - window] ?? 0);
      const avg = sum / window;
      if (avg > best) best = avg;
    }

    const rounded = Math.round(best);
    if (rounded > 0) {
      result[key as keyof typeof DURATIONS] = rounded;
    }
  }

  return result;
}

export function computeMaxHrFromStream(hr: number[]): number | null {
  if (hr.length === 0) return null;
  // reduce, not Math.max(...hr): spreading passes one argument per sample, and
  // engines throw RangeError past a few hundred thousand. These are per-second
  // recordings from rides that can run many hours.
  const max = hr.reduce((m, v) => (v > m ? v : m), 0);
  return max > 0 ? max : null;
}

export function mergeBests(current: BestsMap, incoming: BestsMap): BestsMap {
  const merged = { ...current };
  for (const key of Object.keys(DURATIONS) as Array<keyof typeof DURATIONS>) {
    const inc = incoming[key];
    if (inc != null && (merged[key] == null || inc > merged[key]!)) {
      merged[key] = inc;
    }
  }
  return merged;
}
