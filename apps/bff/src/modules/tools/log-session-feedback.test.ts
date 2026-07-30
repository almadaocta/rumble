// Regression test for a real gap found in this codebase: the SELECT that
// validates a session belongs to the requesting athlete was correct, but the
// subsequent UPDATE only matched on session id, not re-checking athleteId at
// the point of mutation — a check-then-act gap. Now the update itself is
// scoped too; this test guarantees it stays that way.
import { describe, it, expect, beforeAll } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { trainingPlans, planSessions } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logSessionFeedback } from './log-session-feedback.js';
import { buildSlimPreamble } from '../athlete/context-preamble.js';

describe('logSessionFeedback cross-tenant isolation', () => {
  let athleteA: string;
  let athleteB: string;
  let sessionId: string;

  beforeAll(async () => {
    migrateTestDb();
    athleteA = await seedAthlete('Athlete A');
    athleteB = await seedAthlete('Athlete B');

    const [plan] = await db
      .insert(trainingPlans)
      .values({ athleteId: athleteA, name: 'Base Plan', startDate: '2026-01-01' })
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
    sessionId = session.id;
  });

  it("lets athlete A log feedback on their own session", async () => {
    const result = (await logSessionFeedback({ session_id: sessionId, rpe: 7 }, athleteA)) as { ok?: boolean };
    expect(result.ok).toBe(true);
  });

  it("refuses when athlete B targets athlete A's session id", async () => {
    const result = (await logSessionFeedback({ session_id: sessionId, rpe: 9, notes: 'hijacked' }, athleteB)) as {
      error?: string;
    };
    expect(result.error).toBeTruthy();

    // The earlier feedback from athlete A must be untouched — not overwritten.
    const [row] = await db.select().from(planSessions).where(eq(planSessions.id, sessionId));
    expect(row.feedbackRpe).toBe(7);
    expect(row.feedbackNotes).not.toBe('hijacked');
  });
});

/**
 * Regression test for a stale-context bug: buildSlimPreamble renders each
 * session's `completed` flag, and used to serve it from a 5-minute per-athlete
 * cache. logSessionFeedback writes that flag but was the only preamble-affecting
 * write tool that did not invalidate, so right after an athlete reported
 * finishing a session the coach's own context still said it was outstanding.
 *
 * That cache has since been removed — a full build measured 0.73 ms, which
 * wasn't worth the staleness it kept causing. This now asserts the property the
 * athlete actually cares about rather than the mechanism that used to enforce it.
 */
describe('logSessionFeedback session freshness', () => {
  let athleteId: string;
  let sessionId: string;

  beforeAll(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Preamble Athlete');

    const [plan] = await db
      .insert(trainingPlans)
      .values({ athleteId, name: 'Build Plan', startDate: '2026-01-01' })
      .returning();

    const [session] = await db
      .insert(planSessions)
      .values({
        planId: plan.id,
        athleteId,
        scheduledDate: new Date().toISOString().slice(0, 10),
        sessionType: 'ride',
        title: 'Threshold intervals',
      })
      .returning();
    sessionId = session.id;
  });

  it('reflects the completed session in the very next preamble build', async () => {
    // Read it once while the session is still outstanding.
    const before = await buildSlimPreamble(athleteId);
    expect(before).toContain('Threshold intervals');
    expect(before).not.toContain('Threshold intervals done');

    await logSessionFeedback({ session_id: sessionId, rpe: 8, completed: true }, athleteId);

    // Without invalidation this would return the primed string for 5 minutes.
    const after = await buildSlimPreamble(athleteId);
    expect(after).toContain('Threshold intervals done');
  });
});
