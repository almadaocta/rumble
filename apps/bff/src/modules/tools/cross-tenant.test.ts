/**
 * Cross-tenant isolation across the tool handlers that accept a caller-supplied
 * record id.
 *
 * The README's central architectural claim is that every query is scoped by
 * athleteId, but only one handler (log-session-feedback) actually had a
 * regression test proving it. These handlers are structurally identical — a
 * hand audit is not a guarantee, and the model chooses these ids from context
 * it partly controls.
 *
 * Each case asks: given athlete B and an id belonging to athlete A, does the
 * handler refuse?
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { activities, activityStreams, trainingPlans, planSessions } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { analyzeActivity } from './analyze-activity.js';
import { updateTrainingPlan } from './update-training-plan.js';
import { logSessionFeedback } from './log-session-feedback.js';

describe('tool handlers reject cross-tenant ids', () => {
  let athleteA: string;
  let athleteB: string;
  let activityId: string;
  let planId: string;
  let sessionId: string;

  beforeAll(async () => {
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
      })
      .returning();
    activityId = activity.id;

    // Streams are fetched by activity id alone, so the athlete-scoped guard on
    // the parent row is the only thing standing between B and A's power data.
    await db.insert(activityStreams).values({
      activityId,
      timestamps: [0, 1],
      power: [250, 260],
      sampleCount: 2,
    });

    const [plan] = await db
      .insert(trainingPlans)
      .values({ athleteId: athleteA, name: "Athlete A's plan", startDate: '2026-01-01' })
      .returning();
    planId = plan.id;

    const [session] = await db
      .insert(planSessions)
      .values({
        planId,
        athleteId: athleteA,
        scheduledDate: '2026-01-05',
        sessionType: 'ride',
        title: "Athlete A's session",
      })
      .returning();
    sessionId = session.id;
  });

  it('analyze_activity refuses another athlete’s activity, and leaks no stream data', async () => {
    const result = await analyzeActivity({ activity_id: activityId }, athleteB);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // The power stream must not appear in the refusal payload.
    expect(JSON.stringify(result)).not.toContain('250');
    expect(JSON.stringify(result)).not.toContain("Athlete A's ride");
  });

  it('analyze_activity still serves the owning athlete', async () => {
    const result = await analyzeActivity({ activity_id: activityId }, athleteA);
    expect(result.ok).toBe(true);
  });

  it('update_training_plan refuses to add sessions to another athlete’s plan', async () => {
    const result = await updateTrainingPlan(
      {
        action: 'add_sessions',
        plan_id: planId,
        sessions: [
          { scheduled_date: '2026-02-01', session_type: 'ride', title: 'Injected session' },
        ],
      },
      athleteB,
    );

    expect(result.ok).toBe(false);

    // And nothing was written into athlete A's plan.
    const rows = await db.select().from(planSessions).where(eq(planSessions.planId, planId));
    expect(rows.map((r) => r.title)).not.toContain('Injected session');
  });

  it('update_training_plan refuses to mutate another athlete’s plan metadata', async () => {
    await updateTrainingPlan({ action: 'update', plan_id: planId, name: 'Hijacked' }, athleteB);

    const [row] = await db.select().from(trainingPlans).where(eq(trainingPlans.id, planId));
    expect(row.name).toBe("Athlete A's plan");
  });

  it('log_session_feedback refuses another athlete’s session', async () => {
    const result = await logSessionFeedback(
      { session_id: sessionId, rpe: 9, notes: 'hijacked' },
      athleteB,
    );

    expect(result.ok).toBe(false);

    const [row] = await db.select().from(planSessions).where(eq(planSessions.id, sessionId));
    expect(row.feedbackNotes).not.toBe('hijacked');
  });
});
