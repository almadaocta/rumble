// Coggan training-load model: CTL (fitness) = 42-day EMA of daily TSS, ATL
// (fatigue) = 7-day EMA of daily TSS, TSB (form) = CTL - ATL. Pulled out as
// pure functions so the math is testable without a database.
export const CTL_DAYS = 42;
export const ATL_DAYS = 7;

/** One day's step of an exponential moving average — today's value nudges yesterday's average by 1/days of the gap. */
export function emaStep(previous: number, todayValue: number, days: number): number {
  return previous + (todayValue - previous) / days;
}

export function round1(n: number): number {
  return Number(n.toFixed(1));
}

/**
 * TSB (form) band cut-points, in TSB units.
 *
 * These were restated in three places — the coach's context preamble, the
 * get_body_metrics tool, and the web client's label/colour scale — so the
 * number the athlete saw on the dashboard could disagree with the word the
 * coach used in the same breath. The BFF now reads them from here.
 *
 * `apps/web/src/lib/training.ts` still carries its own copy: the two packages
 * share no library, and adding one for four numbers isn't worth it yet. Both
 * sides reference this comment, so a change here has an obvious second stop.
 */
export const TSB_BANDS = {
  veryFresh: 15,
  fresh: 5,
  neutral: -10,
  fatigued: -20,
} as const;

export type FormStatus =
  | 'unknown'
  | 'very_fresh'
  | 'fresh'
  | 'neutral'
  | 'fatigued'
  | 'very_fatigued';

/** Full six-way classification, used where the nuance is worth the extra words. */
export function classifyForm(tsb: number | null): FormStatus {
  if (tsb === null) return 'unknown';
  if (tsb > TSB_BANDS.veryFresh) return 'very_fresh';
  if (tsb > TSB_BANDS.fresh) return 'fresh';
  if (tsb > TSB_BANDS.neutral) return 'neutral';
  if (tsb > TSB_BANDS.fatigued) return 'fatigued';
  return 'very_fatigued';
}

/** Coarse three-way label for prose, where "very fresh" adds nothing. */
export function formLabel(tsb: number): 'fresh' | 'neutral' | 'fatigued' {
  if (tsb > TSB_BANDS.fresh) return 'fresh';
  if (tsb < TSB_BANDS.neutral) return 'fatigued';
  return 'neutral';
}
