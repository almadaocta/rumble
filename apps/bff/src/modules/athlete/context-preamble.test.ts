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
import { targetEvents, dailyMetrics, coachingNotes } from '../../db/schema.js';
import { buildDetailedContext, buildSlimPreamble } from './context-preamble.js';

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

/**
 * buildSlimPreamble runs on every turn of every chat, including a brand new
 * thread with no message history — it's the one thing that carries an
 * athlete's durable history across a chatId reset. But sending every note in
 * full would make per-turn cost grow with the athlete's entire season, so
 * only health/constraint/preference render in full; everything else collapses
 * to a per-category count pointing at get_coaching_notes.
 */
describe('buildSlimPreamble coaching notes', () => {
  let athleteId: string;

  beforeEach(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Notes Athlete');
  });

  it('renders pinned categories in full', async () => {
    await db.insert(coachingNotes).values({
      athleteId,
      category: 'health',
      content: 'Back injury — no loaded spinal flexion',
    });

    const preamble = await buildSlimPreamble(athleteId);
    expect(preamble).toContain('[health] Back injury — no loaded spinal flexion');
  });

  it('collapses non-pinned categories to a per-category count, not full content', async () => {
    await db.insert(coachingNotes).values([
      { athleteId, category: 'decision', content: 'Pacing plan: 205W NP ceiling first hour' },
      { athleteId, category: 'nutrition', content: 'Macro targets: 6g/kg carb on hard days' },
    ]);

    const preamble = await buildSlimPreamble(athleteId);
    expect(preamble).not.toContain('205W NP ceiling');
    expect(preamble).not.toContain('6g/kg carb');
    expect(preamble).toContain('decision: 1');
    expect(preamble).toContain('nutrition: 1');
    expect(preamble).toContain('get_coaching_notes');
  });

  it('omits the archive line entirely when there is nothing archived', async () => {
    await db.insert(coachingNotes).values({
      athleteId,
      category: 'preference',
      content: 'Prefers morning rides',
    });

    const preamble = await buildSlimPreamble(athleteId);
    expect(preamble).not.toContain('Archived coaching notes');
  });

  it('excludes an expired note from both the pinned and archived tiers', async () => {
    await db.insert(coachingNotes).values({
      athleteId,
      category: 'nutrition',
      content: 'Taking antibiotics this week',
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const preamble = await buildSlimPreamble(athleteId);
    expect(preamble).not.toContain('Antibiotics');
    expect(preamble).not.toContain('nutrition: 1');
  });
});
