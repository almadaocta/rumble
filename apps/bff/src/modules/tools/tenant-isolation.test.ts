/**
 * Table-driven tenant isolation across every mutating tool that takes a
 * caller-supplied record id.
 *
 * cross-tenant.test.ts covers a handful by hand. This is the sweep: the README's
 * central architectural claim is that every query is scoped by athleteId, and
 * these handlers are structurally identical, so the guarantee should be asserted
 * uniformly rather than wherever someone remembered to.
 *
 * The model picks these ids from context it partly controls, which is what makes
 * this a security boundary rather than a correctness nicety.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { activities, trainingPlans, planSessions, coachingNotes, athletes } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';

import { analyzeActivity } from './analyze-activity.js';
import { updateAthleteProfile } from './update-athlete-profile.js';
import { updateTrainingPlan } from './update-training-plan.js';
import { logSessionFeedback } from './log-session-feedback.js';
import { pushWorkoutToDevice } from './push-workout-to-device.js';
import { getTrainingData } from './get-training-data.js';
import { getBodyMetrics } from './get-body-metrics.js';
import { getNutritionLog } from './get-nutrition-log.js';

/** Ids belonging to athlete A, rebuilt for each case. */
interface Fixture {
  activityId: string;
  planId: string;
  sessionId: string;
  noteId: string;
}

type Handler = (args: Record<string, unknown>, athleteId: string) => Promise<ToolOutcome>;

interface Case {
  name: string;
  handler: Handler;
  args: (f: Fixture) => Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: 'analyze_activity',
    handler: analyzeActivity,
    args: (f) => ({ activity_id: f.activityId }),
  },
  {
    name: 'log_session_feedback',
    handler: logSessionFeedback,
    args: (f) => ({ session_id: f.sessionId, rpe: 9, notes: 'hijacked' }),
  },
  {
    name: 'update_training_plan (update)',
    handler: updateTrainingPlan,
    args: (f) => ({ action: 'update', plan_id: f.planId, name: 'Hijacked' }),
  },
  {
    name: 'update_training_plan (add_sessions)',
    handler: updateTrainingPlan,
    args: (f) => ({
      action: 'add_sessions',
      plan_id: f.planId,
      sessions: [{ scheduled_date: '2026-02-01', session_type: 'ride', title: 'Injected' }],
    }),
  },
  {
    name: 'push_workout_to_device',
    handler: pushWorkoutToDevice,
    args: (f) => ({ session_id: f.sessionId }),
  },
];

describe('tenant isolation across id-accepting tools', () => {
  let athleteA: string;
  let athleteB: string;
  let fixture: Fixture;

  beforeEach(async () => {
    migrateTestDb();
    athleteA = await seedAthlete('Athlete A');
    athleteB = await seedAthlete('Athlete B');

    const [activity] = await db
      .insert(activities)
      .values({
        athleteId: athleteA,
        source: 'wahoo',
        externalId: 'a-1',
        type: 'ride',
        name: "Athlete A's ride",
        startedAt: new Date('2026-03-01T08:00:00Z'),
        durationS: 3600,
        tss: 70,
      })
      .returning();

    const [plan] = await db
      .insert(trainingPlans)
      .values({ athleteId: athleteA, name: "Athlete A's plan", startDate: '2026-01-01' })
      .returning();

    const [session] = await db
      .insert(planSessions)
      .values({
        planId: plan.id,
        athleteId: athleteA,
        scheduledDate: '2026-01-05',
        sessionType: 'ride',
        title: "Athlete A's session",
      })
      .returning();

    const [note] = await db
      .insert(coachingNotes)
      .values({ athleteId: athleteA, category: 'general', content: "Athlete A's note" })
      .returning();

    fixture = {
      activityId: activity.id,
      planId: plan.id,
      sessionId: session.id,
      noteId: note.id,
    };
  });

  /** Everything of athlete A's that a cross-tenant call must leave untouched. */
  async function snapshotAthleteA() {
    return JSON.stringify({
      activities: await db.select().from(activities).where(eq(activities.athleteId, athleteA)),
      plans: await db.select().from(trainingPlans).where(eq(trainingPlans.athleteId, athleteA)),
      sessions: await db.select().from(planSessions).where(eq(planSessions.athleteId, athleteA)),
      notes: await db.select().from(coachingNotes).where(eq(coachingNotes.athleteId, athleteA)),
    });
  }

  for (const testCase of CASES) {
    it(`${testCase.name} refuses athlete B and leaves A's data byte-identical`, async () => {
      const before = await snapshotAthleteA();

      const result = await testCase.handler(testCase.args(fixture), athleteB);

      // Declined, not silently succeeded.
      expect(result.ok, `${testCase.name} should refuse`).toBe(false);

      // And nothing of A's moved.
      expect(await snapshotAthleteA()).toBe(before);
    });

    it(`${testCase.name} does not leak A's content in its refusal`, async () => {
      const result = await testCase.handler(testCase.args(fixture), athleteB);
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain("Athlete A's ride");
      expect(serialized).not.toContain("Athlete A's plan");
      expect(serialized).not.toContain("Athlete A's session");
      expect(serialized).not.toContain("Athlete A's note");
    });
  }

  it('the same calls succeed for the owning athlete', async () => {
    // Guards against the sweep passing merely because every handler is broken.
    const feedback = await logSessionFeedback(
      { session_id: fixture.sessionId, rpe: 7 },
      athleteA,
    );
    expect(feedback.ok).toBe(true);

    const renamed = await updateTrainingPlan(
      { action: 'update', plan_id: fixture.planId, name: 'Renamed by owner' },
      athleteA,
    );
    expect(renamed.ok).toBe(true);

    // analyze_activity is deliberately not asserted here: the seeded activity
    // has no stream rows, so it legitimately declines for the owner too. Its
    // owner-path success is covered in cross-tenant.test.ts, which seeds streams.
  });

  it('getTrainingData activity detail does not expose implementation fields', async () => {
    const [activity] = await db
      .insert(activities)
      .values({
        athleteId: athleteA,
        source: 'wahoo',
        externalId: 'detail-test-1',
        type: 'ride',
        name: 'Detail test ride',
        startedAt: new Date('2026-04-01T09:00:00Z'),
        durationS: 1800,
        tss: 50,
      })
      .returning();

    const result = await getTrainingData({ activity_id: activity.id }, athleteA);

    expect(result.ok).toBe(true);
    // Implementation fields must not be present
    expect(result).not.toHaveProperty('fitFileUrl');
    expect(result).not.toHaveProperty('externalId');
    expect(result).not.toHaveProperty('source');
    expect(result).not.toHaveProperty('athleteId');
    expect(result).not.toHaveProperty('createdAt');
    // Expected fields must be present
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('type');
    expect(result).toHaveProperty('durationS');
  });

  it('getBodyMetrics result does not contain the static Wahoo note', async () => {
    const athleteId = await seedAthlete('Wahoo Note Athlete');

    const result = await getBodyMetrics({}, athleteId);

    expect(result.ok).toBe(true);
    const readiness = (result as Record<string, unknown>).readiness as Record<string, unknown>;
    expect(readiness).not.toHaveProperty('note');
  });

  it('updateAthleteProfile can set daily_calorie_adjustment', async () => {
    const athleteId = await seedAthlete('Calorie Adjustment Athlete');

    const result = await updateAthleteProfile({ daily_calorie_adjustment: -500 }, athleteId);

    expect(result.ok).toBe(true);
    expect((result as Record<string, unknown>).updated_fields).toContain('daily_calorie_adjustment');

    // Verify it was actually persisted
    const [row] = await db
      .select({ dailyCalorieAdjustment: athletes.dailyCalorieAdjustment })
      .from(athletes)
      .where(eq(athletes.id, athleteId));
    expect(row.dailyCalorieAdjustment).toBe(-500);
  });

  it('getTrainingData list response omits redundant computed fields', async () => {
    const athleteId = await seedAthlete('Redundant Fields Athlete');
    // Insert an activity with known distance
    await db.insert(activities).values({
      id: randomUUID(),
      athleteId,
      externalId: 'redundant-test-1',
      source: 'manual',
      type: 'ride',
      name: 'Test Ride',
      startedAt: new Date(),
      durationS: 3600,
      distanceM: 50000,
    });

    const result = await getTrainingData({ days: 30 }, athleteId);

    expect(result.ok).toBe(true);
    const acts = (result as Record<string, unknown>).activities as Record<string, unknown>[];
    expect(acts.length).toBeGreaterThan(0);

    // Redundant fields must not be present on list items
    expect(acts[0]).not.toHaveProperty('durationFormatted');
    expect(acts[0]).not.toHaveProperty('distanceM');
    // These should still be present
    expect(acts[0]).toHaveProperty('durationS');
    expect(acts[0]).toHaveProperty('distanceKm');
  });

  it('getNutritionLog single-day response includes calorie_target and calories_burned', async () => {
    const athleteId = await seedAthlete('Calorie Target Athlete');

    // Set up complete biometrics
    await db.update(athletes)
      .set({ weightKg: 75, heightCm: 178, age: 30, sex: 'male', dailyCalorieAdjustment: 0 })
      .where(eq(athletes.id, athleteId));

    const today = new Date().toISOString().slice(0, 10);

    // Seed an activity with calories
    await db.insert(activities).values({
      id: randomUUID(),
      athleteId,
      externalId: 'nut-log-burned-1',
      source: 'wahoo',
      type: 'ride',
      name: 'Ride',
      startedAt: new Date(),
      durationS: 3600,
      calories: 700,
    });

    const result = await getNutritionLog({ date: today, days: 1 }, athleteId);

    expect(result.ok).toBe(true);
    const r = result as Record<string, unknown>;
    // Male, 75kg, 178cm, 30yo = 1718 BMR; adjustment 0 = 1718 target
    expect(r.calorie_target).toBe(1718);
    expect(r.calories_burned).toBe(700);
    // net = consumed (0, no meals logged) - burned (700) = -700
    expect(r.net_calories).toBe(-700);
  });

  it('getNutritionLog returns null calorie_target when profile incomplete', async () => {
    const athleteId = await seedAthlete('Incomplete Profile Athlete');
    const today = new Date().toISOString().slice(0, 10);

    const result = await getNutritionLog({ date: today, days: 1 }, athleteId);

    expect(result.ok).toBe(true);
    const r = result as Record<string, unknown>;
    expect(r.calorie_target).toBeNull();
    expect(r.calories_burned).toBe(0);
    expect(r.net_calories).toBeNull();
  });
});
