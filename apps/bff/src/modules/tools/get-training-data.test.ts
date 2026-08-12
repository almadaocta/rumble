// Regression test: activePlan used to omit `id`, so update_training_plan's
// `update`/`add_sessions` actions — which require plan_id — had no way to
// discover it. The model could see its plan but never legally reference it.
import { describe, it, expect, beforeEach } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { trainingPlans } from '../../db/schema.js';
import { getTrainingData } from './get-training-data.js';

describe('getTrainingData activePlan', () => {
  let athleteId: string;

  beforeEach(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Plan Athlete');
  });

  it('includes the plan id so the model can pass it back to update_training_plan', async () => {
    const [plan] = await db
      .insert(trainingPlans)
      .values({ athleteId, name: 'Girona Build', startDate: '2026-08-01', isActive: true })
      .returning();

    const result = (await getTrainingData({}, athleteId)) as { activePlan?: { id?: string } };

    expect(result.activePlan?.id).toBe(plan.id);
  });

  it('returns null when there is no active plan, not a plan-shaped object with a missing id', async () => {
    const result = (await getTrainingData({}, athleteId)) as { activePlan?: unknown };
    expect(result.activePlan).toBeNull();
  });
});
