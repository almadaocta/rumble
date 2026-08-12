// Regression coverage for two real gaps: update_training_plan's `update` and
// `add_sessions` actions require a plan_id, but nothing ever surfaced one back
// to the model (see get-training-data.test.ts) — and there was no way to
// delete a wrong or duplicate session at all, only add more on top of it. Both
// bugs together are what let a mis-dated multi-week plan turn into a calendar
// full of unremovable duplicates.
import { describe, it, expect, beforeEach } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { planSessions } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { updateTrainingPlan } from './update-training-plan.js';
import type { ToolOutcome } from './tool-result.js';

describe('updateTrainingPlan remove_sessions', () => {
  let athleteId: string;
  let otherAthleteId: string;
  let sessionId: string;
  let otherAthleteSessionId: string;

  beforeEach(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Plan Athlete');
    otherAthleteId = await seedAthlete('Other Athlete');

    await updateTrainingPlan(
      {
        action: 'create',
        name: 'Girona Build',
        sessions: [
          { scheduled_date: '2026-08-11', session_type: 'ride', title: 'Duplicate VO2max' },
          { scheduled_date: '2026-08-11', session_type: 'rest', title: 'Correct rest day' },
        ],
      },
      athleteId,
    );
    const rows = await db.select().from(planSessions).where(eq(planSessions.athleteId, athleteId));
    sessionId = rows.find((r) => r.title === 'Duplicate VO2max')!.id;

    await updateTrainingPlan(
      { action: 'create', name: 'Other Plan', sessions: [{ scheduled_date: '2026-08-11', session_type: 'ride', title: "Other athlete's session" }] },
      otherAthleteId,
    );
    const otherRows = await db.select().from(planSessions).where(eq(planSessions.athleteId, otherAthleteId));
    otherAthleteSessionId = otherRows[0].id;
  });

  it('deletes the named session and leaves the rest of the plan alone', async () => {
    const result = (await updateTrainingPlan(
      { action: 'remove_sessions', session_ids: [sessionId] },
      athleteId,
    )) as ToolOutcome & { sessions_removed?: number };

    expect(result.ok).toBe(true);
    expect(result.sessions_removed).toBe(1);

    const remaining = await db.select().from(planSessions).where(eq(planSessions.athleteId, athleteId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('Correct rest day');
  });

  it("refuses to delete another athlete's session even if the id is known", async () => {
    const result = (await updateTrainingPlan(
      { action: 'remove_sessions', session_ids: [otherAthleteSessionId] },
      athleteId,
    )) as ToolOutcome & { sessions_removed?: number };

    expect(result.ok).toBe(true);
    expect(result.sessions_removed).toBe(0);

    const stillThere = await db.select().from(planSessions).where(eq(planSessions.id, otherAthleteSessionId));
    expect(stillThere).toHaveLength(1);
  });

  it('rejects an empty session_ids array instead of silently no-opping', async () => {
    const result = (await updateTrainingPlan({ action: 'remove_sessions' }, athleteId)) as ToolOutcome;
    expect(result.ok).toBe(false);
  });
});
