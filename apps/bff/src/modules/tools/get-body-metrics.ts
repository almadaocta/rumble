import { db } from '../../db/client.js';
import { athletes, dailyMetrics } from '../../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';
import { classifyForm } from '../metrics/training-load.js';

/**
 * Numeric column to number, preserving "missing" as null.
 *
 * One helper for the whole payload, because the two obvious shortcuts are
 * wrong in opposite directions: `Number(latest.ctl)` turns a *missing* CTL into
 * 0, so the coach reads "CTL: 0" for an athlete who has no metrics yet, and
 * `m.ctl ? Number(m.ctl) : null` turns a *legitimate* 0 into null — which for
 * TSB is a real value meaning perfectly balanced, not absence of data.
 */
function num(value: unknown): number | null {
  return value == null ? null : Number(value);
}

export async function getBodyMetrics(
  _args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const [athlete, recentMetrics] = await Promise.all([
    db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1),
    db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.athleteId, athleteId))
      .orderBy(desc(dailyMetrics.date))
      .limit(7),
  ]);

  const profile = athlete[0];
  if (!profile) return { ok: false, error: 'Athlete not found' };

  const latest = recentMetrics[0];
  const tsb = num(latest?.tsb);

  const formStatus = classifyForm(tsb);

  let rampAssessment: string | null = null;
  const rampRate = num(latest?.rampRate);
  // != null, not truthiness: a ramp rate of 0 is a flat week, which is
  // "conservative" — the previous guard reported no assessment at all for it.
  if (rampRate != null) {
    const rr = rampRate;
    if (rr < 3) rampAssessment = 'conservative';
    else if (rr <= 5) rampAssessment = 'safe';
    else if (rr <= 7) rampAssessment = 'aggressive';
    else rampAssessment = 'dangerous — injury risk';
  }

  return {
    ok: true,
    profile: {
      weight_kg: profile.weightKg,
      height_cm: profile.heightCm,
      age: profile.age,
      ftp: profile.ftp,
      ftp_updated_at: profile.ftpUpdatedAt,
    },
    readiness: {
      source: 'tsb',
      note: 'Wahoo does not provide sleep/HRV. Readiness is derived from Training Stress Balance (CTL - ATL). Add Garmin/Whoop post-MVP for sleep and HRV data.',
      form_status: formStatus,
      tsb,
      ctl: num(latest?.ctl),
      atl: num(latest?.atl),
      ramp_rate: num(latest?.rampRate),
      ramp_assessment: rampAssessment,
    },
    metrics_trend: recentMetrics.map((m) => ({
      date: m.date,
      daily_tss: num(m.dailyTss),
      ctl: num(m.ctl),
      atl: num(m.atl),
      tsb: num(m.tsb),
    })),
  };
}
