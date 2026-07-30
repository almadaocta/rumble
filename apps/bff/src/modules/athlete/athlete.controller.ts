/**
 * Read API for the athlete's own dashboard data.
 *
 * Served from /api/athlete/* so the path says what the data is. Kept out of the
 * chat module, which would otherwise own the app's general read surface — the
 * React app's training load and calendar have nothing to do with chat.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../../db/client.js';
import {
  athletes,
  activities,
  trainingPlans,
  planSessions,
  targetEvents,
  dailyMetrics,
  personalBests,
} from '../../db/schema.js';
import {
  eq,
  desc,
  gte,
  lte,
  and,
  asc,
} from 'drizzle-orm';
import { resolveAthleteId } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/error-handler.js';
import { utcDateString } from '../../lib/format.js';

export const athleteController: Router = Router();
athleteController.use(resolveAthleteId);

/**
 * A non-negative week count from a query param, or `fallback` when absent or
 * unparseable. Zero is a legitimate answer and has to survive.
 */
function weekCount(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return typeof raw === 'string' && raw !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

athleteController.get('/sessions', asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;

  let startStr: string;
  let endStr: string;

  if (typeof req.query.from === 'string' && typeof req.query.to === 'string') {
    startStr = req.query.from;
    endStr = req.query.to;
  } else {
    // `?? default` after a NaN check, not `|| default`: TodayTab asks for
    // `past=0` — "no history, just what's ahead" — and `Number('0') || 1` is 1,
    // so it silently got a week of past sessions and could show a completed
    // ride as the next one up.
    const weeksAhead = Math.min(weekCount(req.query.weeks, 4), 12);
    const weeksBehind = Math.min(weekCount(req.query.past, 1), 4);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - weeksBehind * 7);
    startStr = utcDateString(startDate);

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + weeksAhead * 7);
    endStr = utcDateString(endDate);
  }

  const sessions = await db
    .select({
      id: planSessions.id,
      scheduledDate: planSessions.scheduledDate,
      sessionType: planSessions.sessionType,
      title: planSessions.title,
      description: planSessions.description,
      targetTss: planSessions.targetTss,
      targetDurationMin: planSessions.targetDurationMin,
      targetIf: planSessions.targetIf,
      completed: planSessions.completed,
      feedbackRpe: planSessions.feedbackRpe,
    })
    .from(planSessions)
    .where(
      and(
        eq(planSessions.athleteId, athleteId),
        gte(planSessions.scheduledDate, startStr),
        lte(planSessions.scheduledDate, endStr),
      ),
    )
    .orderBy(asc(planSessions.scheduledDate));

  const [activePlan] = await db
    .select({
      id: trainingPlans.id,
      name: trainingPlans.name,
      phase: trainingPlans.phase,
      methodology: trainingPlans.methodology,
    })
    .from(trainingPlans)
    .where(and(eq(trainingPlans.athleteId, athleteId), eq(trainingPlans.isActive, true)))
    .limit(1);

  res.json({ sessions, plan: activePlan ?? null });
}));

athleteController.get('/stats', asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;

  const [athlete] = await db
    .select({
      name: athletes.name,
      ftp: athletes.ftp,
      ftpUpdatedAt: athletes.ftpUpdatedAt,
      weightKg: athletes.weightKg,
      heightCm: athletes.heightCm,
      age: athletes.age,
      experienceLevel: athletes.experienceLevel,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);

  // 404, not a 200 carrying an error body — a client checking res.ok has to
  // be able to trust it. This one shape forced TodayTab to also test
  // `!data.error` on an otherwise-successful response.
  if (!athlete) return res.status(404).json({ error: 'No athlete' });

  const wkg =
    athlete.ftp && athlete.weightKg ? (athlete.ftp / Number(athlete.weightKg)).toFixed(2) : null;

  const today = utcDateString();
  const [latestMetrics] = await db
    .select({
      ctl: dailyMetrics.ctl,
      atl: dailyMetrics.atl,
      tsb: dailyMetrics.tsb,
      rampRate: dailyMetrics.rampRate,
    })
    .from(dailyMetrics)
    .where(eq(dailyMetrics.athleteId, athleteId))
    .orderBy(desc(dailyMetrics.date))
    .limit(1);

  const nextEvent = await db
    .select({
      name: targetEvents.name,
      eventDate: targetEvents.eventDate,
      eventType: targetEvents.eventType,
      priority: targetEvents.priority,
    })
    .from(targetEvents)
    .where(and(eq(targetEvents.athleteId, athleteId), gte(targetEvents.eventDate, today)))
    .orderBy(asc(targetEvents.eventDate))
    .limit(1);

  const [bests] = await db
    .select()
    .from(personalBests)
    .where(eq(personalBests.athleteId, athleteId))
    .limit(1);

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const recentActs = await db
    .select({ durationS: activities.durationS, tss: activities.tss })
    .from(activities)
    .where(and(eq(activities.athleteId, athleteId), gte(activities.startedAt, ninetyDaysAgo)));

  const totalRides90d = recentActs.length;
  const totalTss90d = recentActs.reduce((s, a) => s + Number(a.tss ?? 0), 0);
  const totalHours90d = recentActs.reduce((s, a) => s + a.durationS, 0) / 3600;

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const last7 = await db
    .select({ durationS: activities.durationS, tss: activities.tss })
    .from(activities)
    .where(and(eq(activities.athleteId, athleteId), gte(activities.startedAt, sevenDaysAgo)));
  const weekTss = last7.reduce((s, a) => s + Number(a.tss ?? 0), 0);
  const weekHours = last7.reduce((s, a) => s + a.durationS, 0) / 3600;

  res.json({
    profile: {
      name: athlete.name,
      ftp: athlete.ftp,
      ftpUpdatedAt: athlete.ftpUpdatedAt,
      weightKg: athlete.weightKg ? Number(athlete.weightKg) : null,
      wkg,
      heightCm: athlete.heightCm,
      age: athlete.age,
      experienceLevel: athlete.experienceLevel,
    },
    fitness: latestMetrics
      ? {
          ctl: latestMetrics.ctl != null ? Number(latestMetrics.ctl) : null,
          atl: latestMetrics.atl != null ? Number(latestMetrics.atl) : null,
          tsb: latestMetrics.tsb != null ? Number(latestMetrics.tsb) : null,
          rampRate: latestMetrics.rampRate != null ? Number(latestMetrics.rampRate) : null,
        }
      : null,
    nextEvent: nextEvent[0] ?? null,
    powerBests: bests
      ? {
          '1s': bests.best1s,
          '3s': bests.best3s,
          '10s': bests.best10s,
          '30s': bests.best30s,
          '1min': bests.best1min,
          '5min': bests.best5min,
          '10min': bests.best10min,
          '15min': bests.best15min,
          '20min': bests.best20min,
          '30min': bests.best30min,
          '1hr': bests.best1hr,
          '2hr': bests.best2hr,
        }
      : {},
    maxHr: bests?.maxHr ?? null,
    last90days: {
      rides: totalRides90d,
      tss: Math.round(totalTss90d),
      hours: Number(totalHours90d.toFixed(1)),
    },
    thisWeek: {
      tss: Math.round(weekTss),
      hours: Number(weekHours.toFixed(1)),
      rides: last7.length,
    },
  });
}));
