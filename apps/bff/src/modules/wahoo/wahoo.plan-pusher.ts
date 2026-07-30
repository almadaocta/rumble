import { db } from '../../db/client.js';
import { planSessions, athletes } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { wahooClient } from './wahoo.client.js';
import { wahooTokenManager } from './wahoo.token-manager.js';
import { PlanIntervals, type PlanInterval } from '../plans/plan-interval.js';

interface WahooPlanInterval {
  type: 'steady' | 'ramp';
  duration_seconds: number;
  target_power_low: number;
  target_power_high: number;
  name?: string;
}

interface WahooPlanFile {
  name: string;
  intervals: WahooPlanInterval[];
}

export async function pushWorkoutToElemnt(
  athleteId: string,
  sessionId: string,
): Promise<{ wahooPlanId: number }> {
  const [session] = await db
    .select()
    .from(planSessions)
    .where(and(eq(planSessions.id, sessionId), eq(planSessions.athleteId, athleteId)))
    .limit(1);

  if (!session) throw new Error('Session not found');
  if (!session.intervals) throw new Error('Session has no intervals to push');

  const [athlete] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athlete?.ftp) throw new Error('Athlete FTP not set — cannot compute absolute watts');

  const ftp = athlete.ftp;
  const token = await wahooTokenManager.ensureValidToken(athleteId);

  // Parsed, not cast. The column is JSON, so what comes back is genuinely
  // unknown — an `as any[]` here meant a malformed session produced a
  // nonsense workout on the device rather than an error the athlete sees.
  const parsed = PlanIntervals.safeParse(session.intervals);
  if (!parsed.success) {
    throw new Error(
      `Session intervals are malformed and cannot be pushed: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }

  const planFile = buildWahooPlanFile(session.title, parsed.data, ftp);
  const planFileBase64 = Buffer.from(JSON.stringify(planFile)).toString('base64');

  const plan = await wahooClient.createPlan(token, {
    file: `data:application/json;base64,${planFileBase64}`,
    filename: 'plan.json',
    external_id: `rumble_${session.id}`,
    provider_updated_at: new Date().toISOString(),
  });

  const scheduledDate = new Date(session.scheduledDate);
  scheduledDate.setHours(8, 0, 0, 0);

  await wahooClient.createWorkout(token, {
    name: session.title,
    // Wahoo's `workout_token` is an idempotency key, not a credential: it is the
    // partner-supplied identifier Wahoo dedupes on, so pushing the same session
    // twice updates one workout instead of creating two. Deriving it from the
    // session id is what makes the push repeatable. (Secret scanners flag the
    // field name; the actual bearer credential is `token`, the first argument.)
    workout_token: `rumble_${session.id}`,
    workout_type_id: session.sessionType === 'ride' ? 0 : 42,
    starts: scheduledDate.toISOString(),
    minutes: session.targetDurationMin || 60,
    plan_id: plan.id,
  });

  await db
    .update(planSessions)
    .set({ wahooPlanId: plan.id })
    .where(and(eq(planSessions.id, sessionId), eq(planSessions.athleteId, athleteId)));

  return { wahooPlanId: plan.id };
}

export function buildWahooPlanFile(
  name: string,
  intervals: PlanInterval[],
  ftp: number,
): WahooPlanFile {
  const wahooIntervals: WahooPlanInterval[] = [];

  for (const interval of intervals) {
    if (interval.type === 'warmup' || interval.type === 'cooldown') {
      const startPct = interval.start_pct ?? (interval.type === 'warmup' ? 0.5 : 0.7);
      const endPct = interval.end_pct ?? (interval.type === 'warmup' ? 0.75 : 0.4);
      wahooIntervals.push({
        type: 'ramp',
        duration_seconds: interval.duration_s || 600,
        target_power_low: Math.round(startPct * ftp),
        target_power_high: Math.round(endPct * ftp),
        name: interval.type,
      });
    } else if (interval.type === 'interval' || interval.type === 'steady') {
      const pct = interval.power_pct ?? interval.target_pct ?? 1.0;
      const watts = Math.round(pct * ftp);

      // Built as a local block, then appended `repeats` times. Emitting straight
      // into wahooIntervals and reading it back out by position — splice(-2), an
      // unwritten "the last two entries are mine" — is wrong twice over: a set
      // with no recovery step steals the preceding interval (a warmup, say) into
      // the repeat, and removing the block before re-adding it leaves every set
      // one repetition short.
      const block: WahooPlanInterval[] = [
        {
          type: 'steady',
          duration_seconds: interval.duration_s || 300,
          target_power_low: watts - 5,
          target_power_high: watts + 5,
          name: interval.name,
        },
      ];

      if (interval.rest_s && interval.rest_pct) {
        const restWatts = Math.round(interval.rest_pct * ftp);
        block.push({
          type: 'steady',
          duration_seconds: interval.rest_s,
          target_power_low: restWatts - 5,
          target_power_high: restWatts + 5,
          name: 'recovery',
        });
      }

      // Math.max(1, ...): the model writes `repeats`, and a 0 there means it
      // meant "once", not "drop this interval from the workout".
      const repeats = Math.max(1, interval.repeats ?? 1);
      for (let i = 0; i < repeats; i++) {
        wahooIntervals.push(...structuredClone(block));
      }
    }
  }

  return { name, intervals: wahooIntervals };
}
