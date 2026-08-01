import { z } from 'zod';
import { db } from '../../db/client.js';
import { activities, activityLaps, activityStreams, athletes, personalBests } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';
import { formatDuration } from '../../lib/format.js';
import { computeBestsFromPower, DURATIONS } from '../metrics/power-curve.js';
import type { BestsMap } from '../metrics/power-curve.js';
import { updateBestsForActivity } from '../metrics/power-bests.js';
import { createLogger } from '../../logger.js';

const log = createLogger('analyze-activity');

const DURATION_LABEL_MAP: Record<keyof typeof DURATIONS, string> = {
  best1s: '1s',
  best3s: '3s',
  best10s: '10s',
  best30s: '30s',
  best1min: '1min',
  best5min: '5min',
  best10min: '10min',
  best15min: '15min',
  best20min: '20min',
  best30min: '30min',
  best1hr: '1hr',
  best2hr: '2hr',
};

const AnalyzeActivityArgs = z.object({
  activity_id: z.string(),
  include_downsampled: z.boolean().optional().default(false),
});

const DOWNSAMPLE_TARGET = 120;

export async function analyzeActivity(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const { activity_id, include_downsampled } = AnalyzeActivityArgs.parse(args);

  const [activity] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, activity_id), eq(activities.athleteId, athleteId)))
    .limit(1);

  if (!activity) return { ok: false, error: 'Activity not found' };

  const [stream] = await db
    .select()
    .from(activityStreams)
    .where(eq(activityStreams.activityId, activity_id))
    .limit(1);

  if (!stream) {
    return {
      ok: false,
      activity_id,
      name: activity.name,
      error: 'No stream data available for this activity',
    };
  }

  const [[athlete], [storedBests]] = await Promise.all([
    db.select({ ftp: athletes.ftp }).from(athletes).where(eq(athletes.id, athleteId)).limit(1),
    db.select().from(personalBests).where(eq(personalBests.athleteId, athleteId)).limit(1),
  ]);

  const ftp = athlete?.ftp ?? null;
  const power = stream.power as number[] | null;
  const heartRate = stream.heartRate as number[] | null;
  const cadence = stream.cadence as number[] | null;

  const laps = await db
    .select()
    .from(activityLaps)
    .where(eq(activityLaps.activityId, activity_id))
    .orderBy(activityLaps.lapIndex);

  const isSingleLap = laps.length <= 1;

  const result: Record<string, unknown> = {
    activity_id,
    name: activity.name,
    type: activity.type,
    durationS: activity.durationS,
    durationFormatted: formatDuration(activity.durationS),
    sampleCount: stream.sampleCount,
    lapCount: laps.length,
  };

  if (power?.length) {
    const bests: BestsMap | null = storedBests
      ? {
          best1s: storedBests.best1s,
          best3s: storedBests.best3s,
          best10s: storedBests.best10s,
          best30s: storedBests.best30s,
          best1min: storedBests.best1min,
          best5min: storedBests.best5min,
          best10min: storedBests.best10min,
          best15min: storedBests.best15min,
          best20min: storedBests.best20min,
          best30min: storedBests.best30min,
          best1hr: storedBests.best1hr,
          best2hr: storedBests.best2hr,
        }
      : null;
    result.power = computePowerMetrics(power, ftp, bests);
    updateBestsForActivity(athleteId, activity_id).catch((err) =>
      log.warn('Failed to update power bests after analysis', { err }),
    );
  }

  if (heartRate?.length) {
    result.heartRate = computeHrMetrics(heartRate, power);
  }

  if (cadence?.length) {
    const nonZero = cadence.filter((c) => c > 0);
    result.cadence = {
      avg: Math.round(mean(nonZero)),
      max: maxOf(cadence),
    };
  }

  if (include_downsampled || isSingleLap) {
    result.downsampled = buildDownsampled(stream, DOWNSAMPLE_TARGET);
    result.downsampledNote = isSingleLap
      ? 'Single-lap activity: downsampled data included automatically for HR/power trend analysis'
      : 'Downsampled data included as requested';
  }

  return { ok: true, ...result };
}

function computePowerMetrics(
  power: number[],
  ftp: number | null,
  storedBests: BestsMap | null,
) {
  const nonZero = power.filter((p) => p > 0);
  if (nonZero.length === 0) return { avg: 0, max: 0 };

  const avg = Math.round(mean(nonZero));
  const max = maxOf(power);
  const np = normalizedPower(power);

  const metrics: Record<string, unknown> = { avg, max, np };

  if (ftp && ftp > 0) {
    metrics.intensityFactor = Number((np / ftp).toFixed(2));
    metrics.variabilityIndex = Number((np / avg).toFixed(2));
    metrics.powerZones = timeInPowerZones(power, ftp);
  }

  const thirds = splitIntoThirds(nonZero);
  metrics.powerByThird = {
    first: Math.round(mean(thirds[0])),
    middle: Math.round(mean(thirds[1])),
    last: Math.round(mean(thirds[2])),
  };

  const activityBests = computeBestsFromPower(power);
  const curve: Record<string, { watts: number; pr: boolean } | null> = {};
  for (const key of Object.keys(DURATIONS) as Array<keyof typeof DURATIONS>) {
    const label = DURATION_LABEL_MAP[key];
    const watts = activityBests[key];
    if (watts == null) {
      curve[label] = null;
    } else {
      const stored = storedBests?.[key] ?? null;
      curve[label] = { watts, pr: stored == null || watts > stored };
    }
  }
  metrics.curve = curve;

  return metrics;
}

function computeHrMetrics(heartRate: number[], power: number[] | null) {
  const nonZero = heartRate.filter((h) => h > 0);
  if (nonZero.length === 0) return { avg: 0, max: 0 };

  const avg = Math.round(mean(nonZero));
  const max = maxOf(heartRate);

  const metrics: Record<string, unknown> = { avg, max };

  const thirds = splitIntoThirds(nonZero);
  metrics.hrByThird = {
    first: Math.round(mean(thirds[0])),
    middle: Math.round(mean(thirds[1])),
    last: Math.round(mean(thirds[2])),
  };

  const drift = computeHrDrift(heartRate, power);
  if (drift !== null) {
    metrics.drift = drift;
  }

  return metrics;
}

function computeHrDrift(
  heartRate: number[],
  power: number[] | null,
): Record<string, unknown> | null {
  const validHr = heartRate.filter((h) => h > 0);
  if (validHr.length < 60) return null;

  const mid = Math.floor(validHr.length / 2);
  const firstHalf = validHr.slice(0, mid);
  const secondHalf = validHr.slice(mid);
  const hrFirst = mean(firstHalf);
  const hrSecond = mean(secondHalf);
  const hrDriftPct = ((hrSecond - hrFirst) / hrFirst) * 100;

  const result: Record<string, unknown> = {
    firstHalfAvg: Math.round(hrFirst),
    secondHalfAvg: Math.round(hrSecond),
    driftPercent: Number(hrDriftPct.toFixed(1)),
  };

  if (power?.length) {
    const validPower = power.filter((p) => p > 0);
    if (validPower.length >= 60) {
      const pMid = Math.floor(validPower.length / 2);
      const pwFirst = mean(validPower.slice(0, pMid));
      const pwSecond = mean(validPower.slice(pMid));
      result.powerFirstHalfAvg = Math.round(pwFirst);
      result.powerSecondHalfAvg = Math.round(pwSecond);

      const effFirst = hrFirst / pwFirst;
      const effSecond = hrSecond / pwSecond;
      result.cardiacDriftPercent = Number((((effSecond - effFirst) / effFirst) * 100).toFixed(1));
    }
  }

  return result;
}

function timeInPowerZones(power: number[], ftp: number): Record<string, unknown> {
  const zones = [
    { name: 'Z1 Recovery', min: 0, max: 0.55 },
    { name: 'Z2 Endurance', min: 0.55, max: 0.75 },
    { name: 'Z3 Tempo', min: 0.75, max: 0.90 },
    { name: 'Z4 Threshold', min: 0.90, max: 1.05 },
    { name: 'Z5 VO2max', min: 1.05, max: 1.20 },
    { name: 'Z6 Anaerobic', min: 1.20, max: 1.50 },
    { name: 'Z7 Neuromuscular', min: 1.50, max: Infinity },
  ];

  const total = power.length;
  return Object.fromEntries(
    zones.map((z) => {
      const count = power.filter((p) => {
        const ratio = p / ftp;
        return ratio >= z.min && ratio < z.max;
      }).length;
      const pct = Number(((count / total) * 100).toFixed(1));
      const secs = count;
      return [z.name, { percent: pct, seconds: secs, formatted: formatDuration(secs) }];
    }),
  );
}

function normalizedPower(power: number[]): number {
  if (power.length < 30) return Math.round(mean(power));
  const windowSize = 30;
  const rolling: number[] = [];
  let sum = 0;
  for (let i = 0; i < power.length; i++) {
    sum += power[i];
    if (i >= windowSize) sum -= power[i - windowSize];
    if (i >= windowSize - 1) rolling.push(sum / windowSize);
  }
  const fourthPower = rolling.reduce((s, v) => s + v ** 4, 0) / rolling.length;
  return Math.round(fourthPower ** 0.25);
}

function buildDownsampled(
  stream: Record<string, unknown>,
  target: number,
): Record<string, unknown> {
  const power = stream.power as number[] | null;
  const heartRate = stream.heartRate as number[] | null;
  const cadence = stream.cadence as number[] | null;
  const altitude = stream.altitude as number[] | null;

  const len = power?.length || heartRate?.length || 0;
  if (len === 0) return {};

  const step = Math.max(1, Math.floor(len / target));

  const result: Record<string, unknown> = {
    intervalSeconds: step,
    sampleCount: Math.ceil(len / step),
  };

  if (power) result.power = downsampleAvg(power, step);
  if (heartRate) result.heartRate = downsampleAvg(heartRate, step);
  if (cadence) result.cadence = downsampleAvg(cadence, step);
  if (altitude) result.altitude = downsampleAvg(altitude, step);

  return result;
}

function downsampleAvg(arr: number[], step: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < arr.length; i += step) {
    const chunk = arr.slice(i, i + step);
    result.push(Math.round(mean(chunk)));
  }
  return result;
}

function splitIntoThirds<T>(arr: T[]): [T[], T[], T[]] {
  const third = Math.floor(arr.length / 3);
  return [arr.slice(0, third), arr.slice(third, third * 2), arr.slice(third * 2)];
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * Largest value in a stream, or 0 when empty.
 *
 * Not `Math.max(...arr)`: spreading passes one argument per element, and engines
 * cap that in the low hundreds of thousands before throwing RangeError. These
 * are per-second recordings, so a long ride reaches five figures routinely and
 * an ultra-distance file could cross the line — turning a working analysis into
 * a crash on exactly the rides most worth analysing.
 */
function maxOf(arr: number[]): number {
  return arr.reduce((m, v) => (v > m ? v : m), 0);
}

