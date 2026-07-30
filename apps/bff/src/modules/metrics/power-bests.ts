import { db } from '../../db/client.js';
import { activities, activityStreams, personalBests } from '../../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { createLogger } from '../../logger.js';
import {
  emptyBests,
  bestsFrom,
  mergeBests,
  computeBestsFromPower,
  computeMaxHrFromStream,
} from './power-curve.js';

const log = createLogger('power-bests');

export async function updateBestsForActivity(
  athleteId: string,
  activityId: string,
): Promise<void> {
  const [stream] = await db
    .select({ power: activityStreams.power, heartRate: activityStreams.heartRate })
    .from(activityStreams)
    .where(eq(activityStreams.activityId, activityId))
    .limit(1);

  if (!stream) return;

  const power = stream.power as number[] | null;
  const hr = stream.heartRate as number[] | null;

  const activityBests = computeBestsFromPower(power ?? []);
  const activityMaxHr = computeMaxHrFromStream(hr ?? []);

  const [existing] = await db
    .select()
    .from(personalBests)
    .where(eq(personalBests.athleteId, athleteId))
    .limit(1);

  if (!existing) {
    await db.insert(personalBests).values({
      athleteId,
      ...activityBests,
      maxHr: activityMaxHr,
    });
    return;
  }

  const currentBests = bestsFrom(existing);

  const merged = mergeBests(currentBests, activityBests);
  const newMaxHr =
    activityMaxHr != null && (existing.maxHr == null || activityMaxHr > existing.maxHr)
      ? activityMaxHr
      : existing.maxHr;

  await db
    .update(personalBests)
    .set({ ...merged, maxHr: newMaxHr, updatedAt: new Date() })
    .where(eq(personalBests.athleteId, athleteId));
}

export async function recomputeAllBests(athleteId: string): Promise<void> {
  log.info('Recomputing all bests', { athleteId });

  const allActivities = await db
    .select({ id: activities.id })
    .from(activities)
    .where(eq(activities.athleteId, athleteId))
    .orderBy(desc(activities.startedAt));

  let globalBests = emptyBests();
  let globalMaxHr: number | null = null;
  let processed = 0;

  for (const act of allActivities) {
    const [stream] = await db
      .select({ power: activityStreams.power, heartRate: activityStreams.heartRate })
      .from(activityStreams)
      .where(eq(activityStreams.activityId, act.id))
      .limit(1);

    if (!stream) continue;

    const power = stream.power as number[] | null;
    const hr = stream.heartRate as number[] | null;

    const bests = computeBestsFromPower(power ?? []);
    globalBests = mergeBests(globalBests, bests);

    const maxHr = computeMaxHrFromStream(hr ?? []);
    if (maxHr != null && (globalMaxHr == null || maxHr > globalMaxHr)) {
      globalMaxHr = maxHr;
    }

    processed++;
  }

  await db.delete(personalBests).where(eq(personalBests.athleteId, athleteId));
  await db.insert(personalBests).values({
    athleteId,
    ...globalBests,
    maxHr: globalMaxHr,
  });

  log.info('Recompute complete', { processed, total: allActivities.length });

  const labels = Object.entries(globalBests)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${v}W`)
    .join(', ');
  log.debug('Recompute results', { labels, ...(globalMaxHr ? { maxHr: globalMaxHr } : {}) });
}
