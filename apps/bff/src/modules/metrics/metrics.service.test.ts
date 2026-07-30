/**
 * The persisted training-load rollup.
 *
 * training-load.test.ts covers the pure EMA maths; this covers the part that
 * reads activities, carries yesterday's values forward and writes a row — which
 * had no coverage at all, and which the coach quotes directly as the athlete's
 * form. Every case passes an explicit `today` so the assertions don't depend on
 * the date the suite happens to run.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { activities, dailyMetrics } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { recomputeTodayMetrics } from './metrics.service.js';
import { CTL_DAYS, ATL_DAYS, emaStep, round1 } from './training-load.js';

const TODAY = '2026-03-15';

/** A ride on `date` worth `tss`, at midday UTC so the DATE() grouping is unambiguous. */
async function seedRide(athleteId: string, date: string, tss: number) {
  await db.insert(activities).values({
    athleteId,
    source: 'wahoo',
    externalId: `${date}-${tss}`,
    type: 'ride',
    name: 'Ride',
    startedAt: new Date(`${date}T12:00:00Z`),
    durationS: 3600,
    tss,
  });
}

async function rowFor(athleteId: string, date: string) {
  const rows = await db.select().from(dailyMetrics).where(eq(dailyMetrics.athleteId, athleteId));
  return rows.find((r) => r.date === date);
}

describe('recomputeTodayMetrics', () => {
  let athleteId: string;

  beforeEach(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Metrics Athlete');
  });

  it('starts from zero when there is no prior history', async () => {
    await seedRide(athleteId, TODAY, 100);
    await recomputeTodayMetrics(athleteId, TODAY);

    const row = await rowFor(athleteId, TODAY);
    expect(row?.dailyTss).toBe(100);
    // First day: EMA steps up from 0 toward today's load.
    expect(row?.ctl).toBe(round1(emaStep(0, 100, CTL_DAYS)));
    expect(row?.atl).toBe(round1(emaStep(0, 100, ATL_DAYS)));
    expect(row?.tsb).toBe(round1(emaStep(0, 100, CTL_DAYS) - emaStep(0, 100, ATL_DAYS)));
  });

  it('carries the most recent previous row forward', async () => {
    await db.insert(dailyMetrics).values({
      athleteId,
      date: '2026-03-14',
      dailyTss: 0,
      ctl: 50,
      atl: 40,
      tsb: 10,
    });
    await seedRide(athleteId, TODAY, 120);

    await recomputeTodayMetrics(athleteId, TODAY);

    const row = await rowFor(athleteId, TODAY);
    expect(row?.ctl).toBe(round1(emaStep(50, 120, CTL_DAYS)));
    expect(row?.atl).toBe(round1(emaStep(40, 120, ATL_DAYS)));
  });

  it('sums every ride on the day', async () => {
    await seedRide(athleteId, TODAY, 60);
    await seedRide(athleteId, TODAY, 45);
    await recomputeTodayMetrics(athleteId, TODAY);

    expect((await rowFor(athleteId, TODAY))?.dailyTss).toBe(105);
  });

  it('ignores rides from other days', async () => {
    await seedRide(athleteId, '2026-03-14', 200);
    await seedRide(athleteId, TODAY, 30);
    await recomputeTodayMetrics(athleteId, TODAY);

    expect((await rowFor(athleteId, TODAY))?.dailyTss).toBe(30);
  });

  it('records a rest day as zero load rather than skipping the row', async () => {
    await recomputeTodayMetrics(athleteId, TODAY);

    const row = await rowFor(athleteId, TODAY);
    expect(row).toBeDefined();
    expect(row?.dailyTss).toBe(0);
  });

  it('leaves rampRate null when there is no row from seven days earlier', async () => {
    await seedRide(athleteId, TODAY, 80);
    await recomputeTodayMetrics(athleteId, TODAY);

    expect((await rowFor(athleteId, TODAY))?.rampRate).toBeNull();
  });

  it('computes rampRate against the row exactly seven days back', async () => {
    await db.insert(dailyMetrics).values({
      athleteId,
      date: '2026-03-08', // TODAY minus 7
      dailyTss: 0,
      ctl: 30,
      atl: 30,
      tsb: 0,
    });
    await seedRide(athleteId, TODAY, 100);

    await recomputeTodayMetrics(athleteId, TODAY);

    const row = await rowFor(athleteId, TODAY);
    expect(row?.rampRate).not.toBeNull();
    // CTL rose from 30, so the weekly ramp is positive.
    expect(Number(row?.rampRate)).toBeGreaterThan(0);
  });

  it('is idempotent — running twice does not double-count the day', async () => {
    await seedRide(athleteId, TODAY, 90);

    await recomputeTodayMetrics(athleteId, TODAY);
    const first = await rowFor(athleteId, TODAY);
    await recomputeTodayMetrics(athleteId, TODAY);
    const second = await rowFor(athleteId, TODAY);

    expect(second?.dailyTss).toBe(first?.dailyTss);
    expect(second?.ctl).toBe(first?.ctl);

    const all = await db.select().from(dailyMetrics).where(eq(dailyMetrics.athleteId, athleteId));
    expect(all.filter((r) => r.date === TODAY)).toHaveLength(1);
  });

  it('scopes to the requested athlete', async () => {
    const other = await seedAthlete('Other Athlete');
    await seedRide(other, TODAY, 500);
    await seedRide(athleteId, TODAY, 50);

    await recomputeTodayMetrics(athleteId, TODAY);

    expect((await rowFor(athleteId, TODAY))?.dailyTss).toBe(50);
  });
});
