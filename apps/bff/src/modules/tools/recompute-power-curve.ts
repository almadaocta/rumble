import { db } from '../../db/client.js';
import { activities } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';
import { recomputeAllBests } from '../metrics/power-bests.js';

export async function recomputePowerCurve(
  _args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const allActivities = await db
    .select({ id: activities.id })
    .from(activities)
    .where(eq(activities.athleteId, athleteId));

  await recomputeAllBests(athleteId);

  return {
    ok: true,
    message: `Power curve recomputed from ${allActivities.length} activities. Personal bests updated.`,
    activity_count: allActivities.length,
  };
}
