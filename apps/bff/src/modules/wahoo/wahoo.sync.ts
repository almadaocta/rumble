import { db } from '../../db/client.js';
import { athletes } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { wahooClient, WahooWorkoutSummarySchema } from './wahoo.client.js';
import { wahooTokenManager } from './wahoo.token-manager.js';
import { normalizeWahooWorkout } from './wahoo.normalizer.js';
import { downloadAndParseFit, type ParsedFitFile } from '../activities/fit-parser.js';
import { recomputeFromHistory } from '../metrics/metrics.service.js';
import { recomputeAllBests } from '../metrics/power-bests.js';
import { upsertActivity, storeFitDetails, activityExists } from '../activities/activity-store.js';
import { persistActivity } from '../activities/activity-ingest.js';
import { createLogger, describeError } from '../../logger.js';

const log = createLogger('wahoo-sync');
const fitLog = createLogger('fit-parser');

/**
 * Pages through Wahoo workouts and imports whatever isn't already in the DB.
 *
 * Wahoo returns workouts sorted by `starts` descending with no since/updated
 * filter to ask for (confirmed against their API reference — /v1/workouts
 * takes only page/per_page), so the only way to ask for "just new" is to walk
 * pages newest-first and stop at the first workout we've already imported:
 * everything after it is older and already synced. On a first-ever connect
 * nothing exists yet, so this naturally walks the athlete's entire history —
 * the same function serves both the initial backfill and every later resync.
 */
export async function syncFullHistory(athleteId: string): Promise<{ imported: number }> {
  const token = await wahooTokenManager.ensureValidToken(athleteId);

  const [athlete] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  const ftp = athlete?.ftp ?? undefined;

  let page = 1;
  let imported = 0;
  let hasMore = true;
  let reachedKnownWorkout = false;

  log.info('Starting history sync', { athleteId });

  while (hasMore && !reachedKnownWorkout) {
    const response = await wahooClient.getWorkouts(token, { page, per_page: 50 });

    if (!response.workouts || response.workouts.length === 0) {
      break;
    }

    for (const workout of response.workouts) {
      if (!workout.workout_summary) continue;

      if (await activityExists(athleteId, 'wahoo', String(workout.id))) {
        reachedKnownWorkout = true;
        break;
      }

      const normalized = normalizeWahooWorkout(workout.workout_summary, ftp, {
        id: workout.id,
        starts: workout.starts,
        name: workout.name,
        workout_type_id: workout.workout_type_id,
      });
      const activityId = await upsertActivity(athleteId, normalized);

      // Batch path: store streams now, but leave bests and the training-load
      // rollup to the single recompute after the loop.
      if (normalized.fitFileUrl) {
        const parsed = await downloadFitSafely(normalized.fitFileUrl);
        if (parsed) await storeFitDetails(activityId, parsed);
      }

      imported++;
    }

    log.debug('Page imported', { page, workouts: response.workouts.length, total: imported });

    if (reachedKnownWorkout || response.workouts.length < (response.per_page || 50)) {
      hasMore = false;
    } else {
      page++;
    }
  }

  if (imported > 0) {
    log.info('Recomputing CTL/ATL/TSB from history');
    await recomputeFromHistory(athleteId);
    await recomputeAllBests(athleteId);
  }

  await wahooTokenManager.updateLastSync(athleteId);

  log.info('Sync complete', { imported });
  return { imported };
}

/**
 * Imports one workout from a webhook payload.
 *
 * `summary: unknown` is the honest signature — this is called with whatever
 * arrived in the POST body — and the parse below is where it stops being
 * unknown. Typing the parameter would only move the cast to the controller.
 */
export async function syncNewWorkout(athleteId: string, summary: unknown): Promise<void> {
  const [athlete] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  const ftp = athlete?.ftp ?? undefined;

  // Parsed, not asserted: this is a webhook body, so it is whatever was
  // POSTed to us. The `as any` here meant an unexpected payload reached the
  // normalizer and produced an activity built from undefined fields.
  const normalized = normalizeWahooWorkout(WahooWorkoutSummarySchema.parse(summary), ftp);
  const parsed = normalized.fitFileUrl ? await downloadFitSafely(normalized.fitFileUrl) : null;

  await persistActivity(athleteId, normalized, parsed);
  await wahooTokenManager.updateLastSync(athleteId);

  log.debug('Synced workout', { externalId: normalized.externalId, athleteId });
}

export async function syncUserProfile(athleteId: string): Promise<void> {
  const token = await wahooTokenManager.ensureValidToken(athleteId);
  const user = await wahooClient.getUser(token);

  const updates: Record<string, unknown> = {};
  if (user.weight) updates.weightKg = Number(parseFloat(user.weight).toFixed(1));
  if (user.height) updates.heightCm = Math.round(parseFloat(user.height) * 100);

  if (Object.keys(updates).length > 0) {
    await db.update(athletes).set(updates).where(eq(athletes.id, athleteId));
  }
}

export async function syncPowerZones(athleteId: string): Promise<void> {
  const token = await wahooTokenManager.ensureValidToken(athleteId);
  const zones = await wahooClient.getPowerZones(token);

  if (zones.ftp && zones.ftp > 0) {
    const [athlete] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    if (athlete && athlete.ftp !== zones.ftp) {
      await db
        .update(athletes)
        .set({ ftp: zones.ftp, ftpUpdatedAt: new Date() })
        .where(eq(athletes.id, athleteId));
      log.info('Updated FTP from Wahoo', { ftp: zones.ftp });
    }
  }
}


/**
 * Downloads and parses a FIT file, returning null rather than throwing.
 *
 * A missing or malformed FIT file must not fail the whole sync — the activity
 * summary is still worth storing without its streams.
 */
async function downloadFitSafely(fitUrl: string): Promise<ParsedFitFile | null> {
  try {
    return await downloadAndParseFit(fitUrl);
  } catch (err) {
    fitLog.warn('Failed to download/parse FIT', { fitUrl, ...describeError(err) });
    return null;
  }
}
