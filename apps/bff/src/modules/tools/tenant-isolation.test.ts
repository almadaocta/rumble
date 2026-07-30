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
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { activities, trainingPlans, planSessions, coachingNotes } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';

import { analyzeActivity } from './analyze-activity.js';
import { updateTrainingPlan } from './update-training-plan.js';
import { logSessionFeedback } from './log-session-feedback.js';
import { pushWorkoutToDevice } from './push-workout-to-device.js';

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
});
