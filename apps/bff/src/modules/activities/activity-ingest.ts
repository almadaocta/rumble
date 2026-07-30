/**
 * The one path a single new activity takes into the app.
 *
 * `activity-store.ts` owns the raw row writes; this composes them with the
 * derived-state updates that must follow — power bests and the training-load
 * rollup. One place, because otherwise each ingest path carries the sequence by
 * convention, and a convention is exactly what gets forgotten when a third
 * ingest path appears.
 *
 * The full-history Wahoo sync deliberately does *not* use this: it upserts in a
 * loop and recomputes once at the end, which is the right shape for a few
 * hundred activities. It calls the `activity-store` primitives directly.
 */
import { upsertActivity, storeFitDetails } from './activity-store.js';
import { updateBestsForActivity } from '../metrics/power-bests.js';
import { recomputeTodayMetrics, recomputeFromHistory } from '../metrics/metrics.service.js';

/** `YYYY-MM-DD` in the server's local zone, for comparing an activity to today. */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
import type { NormalizedActivity } from './normalized-activity.js';
import type { ParsedFitFile } from './fit-parser.js';

/**
 * Persists one activity and brings everything derived from it up to date.
 *
 * `parsed` is optional because the two callers obtain it differently — the
 * manual upload already has the bytes, the Wahoo sync has to fetch them and may
 * fail. When it is absent there are no streams to store, so power bests are
 * skipped; the training-load rollup always runs, since the activity row itself
 * changed either way.
 *
 * Returns the activity id.
 */
export async function persistActivity(
  athleteId: string,
  normalized: NormalizedActivity,
  parsed?: ParsedFitFile | null,
): Promise<string> {
  const activityId = await upsertActivity(athleteId, normalized);

  if (parsed) {
    await storeFitDetails(activityId, parsed);
    await updateBestsForActivity(athleteId, activityId);
  }

  // recomputeTodayMetrics only rebuilds today's row. A manual .fit upload is
  // routinely backdated — importing last week's ride left CTL/ATL/TSB from that
  // day onward never reflecting it, so the athlete's form silently stayed wrong.
  // Anything not from today has to walk the history forward.
  const isToday = localDayKey(normalized.startedAt) === localDayKey(new Date());
  if (isToday) {
    await recomputeTodayMetrics(athleteId);
  } else {
    await recomputeFromHistory(athleteId);
  }

  return activityId;
}
