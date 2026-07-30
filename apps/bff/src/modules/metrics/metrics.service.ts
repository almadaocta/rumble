import { db } from '../../db/client.js';
import { activities, dailyMetrics } from '../../db/schema.js';
import { eq, asc, sql, and } from 'drizzle-orm';
import { CTL_DAYS, ATL_DAYS, emaStep, round1 } from './training-load.js';
import { createLogger } from '../../logger.js';
import { utcDateString } from '../../lib/format.js';

const log = createLogger('metrics');

/**
 * Rebuilds the training-load row for a single day — today by default.
 *
 * `today` is a parameter rather than a wall-clock read so the behaviour can be
 * tested against a fixed date instead of whatever the suite happens to run on.
 * No caller passes it in production.
 */
export async function recomputeTodayMetrics(
  athleteId: string,
  today: string = utcDateString(),
): Promise<void> {

  const todayActivities = await db
    .select({ tss: activities.tss })
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, athleteId),
        sql`DATE(${activities.startedAt}, 'unixepoch') = ${today}`,
      ),
    );

  const dailyTss = todayActivities.reduce((sum, a) => sum + Number(a.tss ?? 0), 0);

  const previousMetrics = await db
    .select()
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.athleteId, athleteId),
        sql`${dailyMetrics.date} < ${today}`,
      ),
    )
    .orderBy(sql`${dailyMetrics.date} DESC`)
    .limit(1);

  const prevCtl = previousMetrics[0] ? Number(previousMetrics[0].ctl ?? 0) : 0;
  const prevAtl = previousMetrics[0] ? Number(previousMetrics[0].atl ?? 0) : 0;

  const newCtl = emaStep(prevCtl, dailyTss, CTL_DAYS);
  const newAtl = emaStep(prevAtl, dailyTss, ATL_DAYS);
  const newTsb = newCtl - newAtl;

  // Derived from `today` rather than the clock, so passing a fixed date makes
  // the whole computation deterministic.
  const sevenDaysAgo = new Date(`${today}T00:00:00Z`);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
  const sevenDaysAgoStr = utcDateString(sevenDaysAgo);

  const weekOldMetrics = await db
    .select()
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.athleteId, athleteId),
        eq(dailyMetrics.date, sevenDaysAgoStr),
      ),
    )
    .limit(1);

  const rampRate = weekOldMetrics[0]
    ? round1(newCtl - Number(weekOldMetrics[0].ctl ?? 0))
    : null;

  await db
    .insert(dailyMetrics)
    .values({
      athleteId,
      date: today,
      dailyTss: round1(dailyTss),
      ctl: round1(newCtl),
      atl: round1(newAtl),
      tsb: round1(newTsb),
      rampRate,
    })
    .onConflictDoUpdate({
      target: [dailyMetrics.athleteId, dailyMetrics.date],
      set: {
        dailyTss: round1(dailyTss),
        ctl: round1(newCtl),
        atl: round1(newAtl),
        tsb: round1(newTsb),
        rampRate,
      },
    });
}

export async function recomputeFromHistory(athleteId: string): Promise<void> {
  const allActivities = await db
    .select({
      date: sql<string>`DATE(${activities.startedAt}, 'unixepoch')`.as('date'),
      totalTss: sql<string>`COALESCE(SUM(${activities.tss}), 0)`.as('total_tss'),
    })
    .from(activities)
    .where(eq(activities.athleteId, athleteId))
    .groupBy(sql`DATE(${activities.startedAt}, 'unixepoch')`)
    .orderBy(asc(sql`DATE(${activities.startedAt}, 'unixepoch')`));

  if (allActivities.length === 0) return;

  const firstDate = new Date(allActivities[0].date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tssByDate = new Map<string, number>();
  for (const a of allActivities) {
    tssByDate.set(a.date, Number(a.totalTss));
  }

  let ctl = 0;
  let atl = 0;
  const rows: Array<{
    athleteId: string;
    date: string;
    dailyTss: number;
    ctl: number;
    atl: number;
    tsb: number;
    rampRate: number | null;
  }> = [];

  const ctlHistory: number[] = [];

  const current = new Date(firstDate);
  while (current <= today) {
    const dateStr = utcDateString(current);
    const dailyTss = tssByDate.get(dateStr) ?? 0;

    ctl = emaStep(ctl, dailyTss, CTL_DAYS);
    atl = emaStep(atl, dailyTss, ATL_DAYS);
    const tsb = ctl - atl;

    ctlHistory.push(ctl);
    const rampRate =
      ctlHistory.length > 7 ? round1(ctl - ctlHistory[ctlHistory.length - 8]) : null;

    rows.push({
      athleteId,
      date: dateStr,
      dailyTss: round1(dailyTss),
      ctl: round1(ctl),
      atl: round1(atl),
      tsb: round1(tsb),
      rampRate,
    });

    current.setDate(current.getDate() + 1);
  }

  const BATCH_SIZE = 50;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await db
      .insert(dailyMetrics)
      .values(batch)
      .onConflictDoUpdate({
        target: [dailyMetrics.athleteId, dailyMetrics.date],
        set: {
          dailyTss: sql`EXCLUDED.daily_tss`,
          ctl: sql`EXCLUDED.ctl`,
          atl: sql`EXCLUDED.atl`,
          tsb: sql`EXCLUDED.tsb`,
          rampRate: sql`EXCLUDED.ramp_rate`,
        },
      });
  }

  log.info('Recomputed metrics', { days: rows.length, athleteId });
}
