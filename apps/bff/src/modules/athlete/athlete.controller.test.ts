/**
 * The two endpoints the whole UI reads from: /stats feeds the Today tab's hero
 * card and /sessions feeds the calendar.
 *
 * What is worth pinning here is the shape and the windowing, because both are
 * places where a wrong answer looks like a plausible one. `real()` columns come
 * back from Drizzle as strings in some paths and numbers in others, and the web
 * app formats whatever it gets — so a string TSS renders as a string. The date
 * windows decide which rides count toward "this week", and an off-by-one there
 * is invisible until an athlete disagrees with their own numbers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import {
  athletes,
  activities,
  dailyMetrics,
  planSessions,
  trainingPlans,
  targetEvents,
  personalBests,
} from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { athleteController } from './athlete.controller.js';

function buildTestApp(athleteId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.athleteId = athleteId;
    next();
  });
  app.use('/api/athlete', athleteController);
  return app;
}

/** `YYYY-MM-DD`, N days from today. */
function dayOffset(days: number): string {
  const d = new Date(FIXED_NOW);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

/** A Date N days ago, for activity timestamps. */
function daysAgo(days: number): Date {
  const d = new Date(FIXED_NOW);
  d.setDate(d.getDate() - days);
  return d;
}

// Pinned mid-week and mid-month so no window boundary in these tests lands on
// a month or year edge. The fixtures below are built from the clock and the
// production code reads the same clock — unfrozen, a run that crosses midnight
// shifts every offset out from under its assertion.
const FIXED_NOW = new Date('2026-05-13T10:00:00Z');

let athleteId: string;
let app: express.Express;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  migrateTestDb();
  athleteId = await seedAthlete('Stats Athlete');
  app = buildTestApp(athleteId);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/athlete/stats', () => {
  it('404s when the athlete row is gone', async () => {
    await db.delete(athletes).where(eq(athletes.id, athleteId));

    const res = await request(app).get('/api/athlete/stats');

    // A 404, not a 200 carrying an error body — a client checking res.ok has to
    // be able to trust it.
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'No athlete' });
  });

  it('answers with every top-level section even for a brand-new athlete', async () => {
    const res = await request(app).get('/api/athlete/stats');

    expect(res.status).toBe(200);
    // The UI reads all of these unconditionally; a missing key is a crash there.
    expect(Object.keys(res.body).sort()).toEqual([
      'fitness',
      'last90days',
      'maxHr',
      'nextEvent',
      'powerBests',
      'profile',
      'thisWeek',
    ]);
    expect(res.body.fitness).toBeNull();
    expect(res.body.nextEvent).toBeNull();
    expect(res.body.powerBests).toEqual({});
    expect(res.body.thisWeek).toEqual({ tss: 0, hours: 0, rides: 0 });
  });

  it('computes w/kg from FTP and weight, as a 2dp string', async () => {
    await db
      .update(athletes)
      .set({ ftp: 285, weightKg: 71.5 })
      .where(eq(athletes.id, athleteId));

    const { profile } = (await request(app).get('/api/athlete/stats')).body;

    expect(profile.ftp).toBe(285);
    // A number, not the string the `real()` column hands back.
    expect(profile.weightKg).toBe(71.5);
    expect(profile.wkg).toBe('3.99');
  });

  it('leaves w/kg null when either half is missing', async () => {
    await db.update(athletes).set({ ftp: 285, weightKg: null }).where(eq(athletes.id, athleteId));
    expect((await request(app).get('/api/athlete/stats')).body.profile.wkg).toBeNull();

    await db.update(athletes).set({ ftp: null, weightKg: 71.5 }).where(eq(athletes.id, athleteId));
    expect((await request(app).get('/api/athlete/stats')).body.profile.wkg).toBeNull();
  });

  it('returns fitness metrics as numbers, from the most recent day', async () => {
    await db.insert(dailyMetrics).values([
      { athleteId, date: dayOffset(-2), ctl: 40, atl: 30, tsb: 10, rampRate: 2 },
      { athleteId, date: dayOffset(-1), ctl: 65, atl: 20, tsb: 45, rampRate: 5 },
    ]);

    const { fitness } = (await request(app).get('/api/athlete/stats')).body;

    expect(fitness).toEqual({ ctl: 65, atl: 20, tsb: 45, rampRate: 5 });
    for (const v of Object.values(fitness)) expect(typeof v).toBe('number');
  });

  it('keeps a legitimate zero in the fitness block rather than dropping it', async () => {
    // TSB 0 means perfectly balanced — a real reading, not absent data.
    await db.insert(dailyMetrics).values({ athleteId, date: dayOffset(0), ctl: 50, atl: 50, tsb: 0 });

    const { fitness } = (await request(app).get('/api/athlete/stats')).body;

    expect(fitness.tsb).toBe(0);
  });

  it('reports the soonest upcoming event and ignores past ones', async () => {
    await db.insert(targetEvents).values([
      { athleteId, name: 'Last Season Classic', eventDate: dayOffset(-60) },
      { athleteId, name: 'Late Season Target', eventDate: dayOffset(120) },
      { athleteId, name: 'Next Up', eventDate: dayOffset(21) },
    ]);

    const { nextEvent } = (await request(app).get('/api/athlete/stats')).body;

    expect(nextEvent.name).toBe('Next Up');
  });

  it('keys power bests by duration label', async () => {
    await db.insert(personalBests).values({
      athleteId,
      best1s: 1240,
      best5min: 340,
      best20min: 295,
      maxHr: 189,
    });

    const res = await request(app).get('/api/athlete/stats');

    expect(res.body.powerBests['1s']).toBe(1240);
    expect(res.body.powerBests['5min']).toBe(340);
    expect(res.body.powerBests['20min']).toBe(295);
    // Durations with no record present as null, not missing.
    expect(res.body.powerBests['2hr']).toBeNull();
    expect(res.body.maxHr).toBe(189);
  });

  describe('training windows', () => {
    beforeEach(async () => {
      await db.insert(activities).values([
        // Inside 7 days, so inside 90 too.
        { athleteId, externalId: 'a', source: 'manual', type: 'ride', name: 'r1', startedAt: daysAgo(1), durationS: 3600, tss: 80 },
        { athleteId, externalId: 'b', source: 'manual', type: 'ride', name: 'r2', startedAt: daysAgo(6), durationS: 1800, tss: 40 },
        // Inside 90 days only.
        { athleteId, externalId: 'c', source: 'manual', type: 'ride', name: 'r3', startedAt: daysAgo(30), durationS: 7200, tss: 150 },
        // Outside both.
        { athleteId, externalId: 'd', source: 'manual', type: 'ride', name: 'r4', startedAt: daysAgo(200), durationS: 3600, tss: 90 },
      ]);
    });

    it('counts only the last 7 days in thisWeek', async () => {
      const { thisWeek } = (await request(app).get('/api/athlete/stats')).body;

      expect(thisWeek).toEqual({ rides: 2, tss: 120, hours: 1.5 });
    });

    it('counts only the last 90 days in last90days', async () => {
      const { last90days } = (await request(app).get('/api/athlete/stats')).body;

      // The 200-day-old ride is excluded from both windows.
      expect(last90days).toEqual({ rides: 3, tss: 270, hours: 3.5 });
    });

    it('treats a ride with no TSS as zero rather than NaN', async () => {
      await db.insert(activities).values({
        athleteId, externalId: 'e', source: 'manual', type: 'ride',
        name: 'no power', startedAt: daysAgo(2), durationS: 3600, tss: null,
      });

      const { thisWeek } = (await request(app).get('/api/athlete/stats')).body;

      expect(thisWeek.rides).toBe(3);
      expect(thisWeek.tss).toBe(120);
    });
  });

  it('never reports another athlete\'s data', async () => {
    const other = await seedAthlete('Someone Else');
    await db.insert(activities).values({
      athleteId: other, externalId: 'x', source: 'manual', type: 'ride',
      name: 'their ride', startedAt: daysAgo(1), durationS: 3600, tss: 200,
    });
    await db.insert(personalBests).values({ athleteId: other, best1s: 9999 });

    const res = await request(app).get('/api/athlete/stats');

    expect(res.body.thisWeek).toEqual({ tss: 0, hours: 0, rides: 0 });
    expect(res.body.powerBests).toEqual({});
  });
});

describe('GET /api/athlete/sessions', () => {
  beforeEach(async () => {
    // plan_sessions.plan_id is NOT NULL, so a session always belongs to a plan.
    // This one is inactive, which keeps `plan: null` observable below — the
    // endpoint reports the *active* plan, not whichever plan owns the sessions.
    const [plan] = await db
      .insert(trainingPlans)
      .values({ athleteId, name: 'Owning block', startDate: dayOffset(-60), isActive: false })
      .returning();

    await db.insert(planSessions).values([
      { athleteId, planId: plan.id, scheduledDate: dayOffset(-40), sessionType: 'ride', title: 'Way behind' },
      { athleteId, planId: plan.id, scheduledDate: dayOffset(-3), sessionType: 'ride', title: 'Last week' },
      { athleteId, planId: plan.id, scheduledDate: dayOffset(2), sessionType: 'threshold', title: 'Coming up' },
      { athleteId, planId: plan.id, scheduledDate: dayOffset(60), sessionType: 'ride', title: 'Way ahead' },
    ]);
  });

  it('defaults to one week behind and four ahead', async () => {
    const { sessions } = (await request(app).get('/api/athlete/sessions')).body;
    const titles = sessions.map((s: { title: string }) => s.title);

    expect(titles).toContain('Last week');
    expect(titles).toContain('Coming up');
    expect(titles).not.toContain('Way behind');
    expect(titles).not.toContain('Way ahead');
  });

  it('honours an explicit from/to range', async () => {
    const { sessions } = (
      await request(app).get(`/api/athlete/sessions?from=${dayOffset(-90)}&to=${dayOffset(90)}`)
    ).body;

    expect(sessions).toHaveLength(4);
  });

  it('returns sessions in scheduled order', async () => {
    const { sessions } = (
      await request(app).get(`/api/athlete/sessions?from=${dayOffset(-90)}&to=${dayOffset(90)}`)
    ).body;
    const dates = sessions.map((s: { scheduledDate: string }) => s.scheduledDate);

    expect(dates).toEqual([...dates].sort());
  });

  it('treats past=0 as no history at all, not as "unset"', async () => {
    // TodayTab requests `?weeks=3&past=0`. Under `Number(raw) || 1` this asked
    // for zero weeks back and silently got one, so a session completed days ago
    // could surface as the next one up.
    const { sessions } = (await request(app).get('/api/athlete/sessions?weeks=3&past=0')).body;
    const titles = sessions.map((s: { title: string }) => s.title);

    expect(titles).not.toContain('Last week');
    expect(titles).toContain('Coming up');
  });

  it('still falls back to one week back when past is absent or junk', async () => {
    for (const query of ['', '?past=', '?past=abc', '?past=-3']) {
      const { sessions } = (await request(app).get(`/api/athlete/sessions${query}`)).body;
      const titles = sessions.map((s: { title: string }) => s.title);
      expect(titles, query || '(no query)').toContain('Last week');
    }
  });

  it('caps the look-ahead and look-behind rather than trusting the query', async () => {
    // weeks is capped at 12 and past at 4, so a wild request cannot pull the
    // athlete's whole history into a calendar month view.
    const { sessions } = (
      await request(app).get('/api/athlete/sessions?weeks=9999&past=9999')
    ).body;
    const titles = sessions.map((s: { title: string }) => s.title);

    expect(titles).not.toContain('Way behind'); // 40 days back > 4 weeks
    expect(titles).toContain('Way ahead'); // 60 days ahead < 12 weeks
  });

  it('reports the active plan alongside, and null when there is none', async () => {
    expect((await request(app).get('/api/athlete/sessions')).body.plan).toBeNull();

    await db.insert(trainingPlans).values({
      athleteId, name: 'Base 1', startDate: dayOffset(-7), phase: 'base', isActive: true,
    });

    const { plan } = (await request(app).get('/api/athlete/sessions')).body;

    expect(plan).toMatchObject({ name: 'Base 1', phase: 'base' });
  });

  it('never returns another athlete\'s sessions', async () => {
    const other = await seedAthlete('Someone Else');
    const [theirPlan] = await db
      .insert(trainingPlans)
      .values({ athleteId: other, name: 'Their block', startDate: dayOffset(-7), isActive: true })
      .returning();
    await db.insert(planSessions).values({
      athleteId: other, planId: theirPlan.id,
      scheduledDate: dayOffset(1), sessionType: 'ride', title: 'Their session',
    });

    const { sessions } = (await request(app).get('/api/athlete/sessions')).body;

    expect(sessions.map((s: { title: string }) => s.title)).not.toContain('Their session');
  });
});
