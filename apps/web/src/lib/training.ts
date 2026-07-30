// Mirrors TSB_BANDS in apps/bff/src/modules/metrics/training-load.ts, which owns
// these cut-points. The two packages share no library, so this copy is
// deliberate — change both together or the dashboard and the coach disagree.
export function tsbLabel(tsb: number): string {
  if (tsb > 5) return 'Fresh';
  if (tsb < -10) return 'Fatigued';
  return 'Neutral';
}

// Maps the same -10 (fatigued) / +5 (fresh) thresholds to 0-1, so the sunburst's
// colour/density scale lines up exactly with the label shown beside it.
export function tsbIntensity(tsb: number): number {
  return Math.max(0, Math.min(1, (tsb + 10) / 15));
}
