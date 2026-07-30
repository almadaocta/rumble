/**
 * Regression test for a stale-target-event bug: the preamble selected the
 * earliest target event on record with no date filter, and daysBetween applies
 * Math.abs — so a race that had already happened was fed to the coach as
 * "Next event: X in N days". chat.controller.ts filtered the same table with
 * gte(eventDate, today); the preamble didn't.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { eq } from 'drizzle-orm';
import { targetEvents, dailyMetrics } from '../../db/schema.js';
import { buildDetailedContext } from './context-preamble.js';

// Pinned so "200 days ago" and "in 30 days" mean the same thing on every run.
// The production code reads the clock, so vi.setSystemTime is what makes these
// fixtures deterministic rather than merely usually-correct.
const FIXED_NOW = new Date('2026-06-15T09:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function isoDaysFromNow(days: number): string {
  const d = new Date(FIXED_NOW);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

describe('buildDetailedContext target events', () => {
  let athleteId: string;

  beforeEach(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Event Athlete');
  });

  it('ignores an event that has already happened', async () => {
    await db.insert(targetEvents).values({
      athleteId,
      name: 'Last Season Classic',
      eventDate: isoDaysFromNow(-200),
    });

    const preamble = await buildDetailedContext(athleteId);
    expect(preamble).not.toContain('Last Season Classic');
    expect(preamble).not.toContain('Next event');
  });

  it('reports a genuinely upcoming event', async () => {
    await db.insert(targetEvents).values({
      athleteId,
      name: 'Spring Gran Fondo',
      eventDate: isoDaysFromNow(30),
    });

    const preamble = await buildDetailedContext(athleteId);
    expect(preamble).toContain('Spring Gran Fondo');
    // The exact count, not just \d+: Math.abs used to hide a wrong direction,
    // and 30 is only right if the subtraction is signed and the right way round.
    expect(preamble).toContain('Next event: Spring Gran Fondo in 30 days');
  });

  it('picks the soonest upcoming event, not the oldest row', async () => {
    await db.insert(targetEvents).values([
      { athleteId, name: 'Old Race', eventDate: isoDaysFromNow(-50) },
      { athleteId, name: 'Late Season Target', eventDate: isoDaysFromNow(120) },
      { athleteId, name: 'Next Up', eventDate: isoDaysFromNow(14) },
    ]);

    const preamble = await buildDetailedContext(athleteId);
    expect(preamble).toContain('Next Up');
    expect(preamble).not.toContain('Old Race');
    expect(preamble).not.toContain('Late Season Target');
  });
});

/**
 * The preamble renders CTL/ATL/TSB from dailyMetrics, so anything that
 * recomputes those must be visible to the next turn. The overnight rollup used
 * to recompute without invalidating the (now removed) 5-minute cache, leaving
 * the coach quoting yesterday's form. The cache is gone, so this now asserts
 * the property directly rather than the invalidation that used to enforce it.
 */
describe('buildDetailedContext metric freshness', () => {
  let athleteId: string;

  beforeEach(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Metrics Athlete');
  });

  it('reflects recomputed training load on the next build', async () => {
    const today = new Date().toISOString().split('T')[0];
    await db.insert(dailyMetrics).values({ athleteId, date: today, ctl: 40, atl: 30, tsb: 10 });

    const before = await buildDetailedContext(athleteId);
    expect(before).toContain('40');

    // Stand in for the overnight rollup writing new values.
    await db
      .update(dailyMetrics)
      .set({ ctl: 65, atl: 20, tsb: 45 })
      .where(eq(dailyMetrics.athleteId, athleteId));

    const after = await buildDetailedContext(athleteId);
    expect(after).toContain('65');
  });
});
