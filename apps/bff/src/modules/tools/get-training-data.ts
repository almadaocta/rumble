import { z } from 'zod';
import { db } from '../../db/client.js';
import { activities, activityLaps, planSessions, trainingPlans } from '../../db/schema.js';
import { eq, desc, and, gte, lte } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';
import { formatDuration, utcDateString } from '../../lib/format.js';
import { ACTIVITY_TYPES } from '../activities/normalized-activity.js';

const GetTrainingDataArgs = z.object({
  days: z.number().optional().default(7),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  // z.enum, not z.string(): every activity in the table carries one of these
  // four, so any other filter value can only return an empty list — which the
  // model reads as "you have never done that" rather than "that is not a thing
  // you can ask for". A bad value is a ZodError, which tool.executor turns into
  // a message naming the field.
  type: z.enum(ACTIVITY_TYPES).optional(),
  include_plan: z.boolean().optional().default(true),
  include_laps: z.boolean().optional().default(false),
  activity_id: z.string().optional(),
  limit: z.number().optional().default(50),
});

export async function getTrainingData(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const {
    days,
    start_date,
    end_date,
    type,
    include_plan,
    include_laps,
    activity_id,
    limit: requestedLimit,
  } = GetTrainingDataArgs.parse(args);

  const maxLimit = Math.min(requestedLimit, 100);

  if (activity_id) {
    return getActivityDetail(activity_id, athleteId, include_laps);
  }

  let since: Date;
  let until: Date | null = null;

  if (start_date) {
    since = new Date(start_date);
    if (end_date) until = new Date(end_date);
  } else {
    since = new Date();
    since.setDate(since.getDate() - days);
  }

  const conditions = [
    eq(activities.athleteId, athleteId),
    gte(activities.startedAt, since),
    ...(until ? [lte(activities.startedAt, until)] : []),
    ...(type ? [eq(activities.type, type)] : []),
  ];

  const recentActivities = await db
    .select({
      id: activities.id,
      type: activities.type,
      name: activities.name,
      startedAt: activities.startedAt,
      durationS: activities.durationS,
      avgPower: activities.avgPower,
      normPower: activities.normPower,
      maxPower: activities.maxPower,
      avgHr: activities.avgHr,
      maxHr: activities.maxHr,
      avgCadence: activities.avgCadence,
      tss: activities.tss,
      intensityFactor: activities.intensityFactor,
      distanceM: activities.distanceM,
      elevationM: activities.elevationM,
      calories: activities.calories,
    })
    .from(activities)
    .where(and(...conditions))
    .orderBy(desc(activities.startedAt))
    .limit(maxLimit);

  const period = start_date
    ? `${start_date} to ${end_date ?? 'now'}`
    : `last ${days} days`;

  const result: Record<string, unknown> = {
    period,
    activities: recentActivities.map((a) => ({
      ...a,
      durationFormatted: formatDuration(a.durationS),
      // `!= null`: a turbo session records 0 m, which is a measurement, not a
      // gap. Truthiness reports it to the coach as unknown distance.
      distanceKm: a.distanceM != null ? (Number(a.distanceM) / 1000).toFixed(1) : null,
    })),
    totalActivities: recentActivities.length,
    totalTss: recentActivities.reduce((sum, a) => sum + Number(a.tss ?? 0), 0),
  };

  if (include_plan) {
    const today = utcDateString();

    const upcoming = await db
      .select({
        id: planSessions.id,
        scheduledDate: planSessions.scheduledDate,
        sessionType: planSessions.sessionType,
        title: planSessions.title,
        description: planSessions.description,
        targetTss: planSessions.targetTss,
        targetDurationMin: planSessions.targetDurationMin,
        completed: planSessions.completed,
        feedbackRpe: planSessions.feedbackRpe,
        feedbackNotes: planSessions.feedbackNotes,
      })
      .from(planSessions)
      .where(
        and(
          eq(planSessions.athleteId, athleteId),
          gte(planSessions.scheduledDate, today),
        ),
      )
      .orderBy(planSessions.scheduledDate)
      .limit(14);

    const activePlan = await db
      .select()
      .from(trainingPlans)
      .where(and(eq(trainingPlans.athleteId, athleteId), eq(trainingPlans.isActive, true)))
      .limit(1);

    result.upcomingSessions = upcoming;
    result.activePlan = activePlan[0]
      ? {
          name: activePlan[0].name,
          phase: activePlan[0].phase,
          methodology: activePlan[0].methodology,
          weeklyTssTarget: activePlan[0].weeklyTssTarget,
          weeklyHoursTarget: activePlan[0].weeklyHoursTarget,
        }
      : null;
  }

  return { ok: true, ...result };
}

async function getActivityDetail(
  activityId: string,
  athleteId: string,
  includeLaps: boolean,
): Promise<ToolOutcome> {
  const [activity] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.athleteId, athleteId)))
    .limit(1);

  if (!activity) return { ok: false, error: 'Activity not found' };

  const result: Record<string, unknown> = {
    ...activity,
    durationFormatted: formatDuration(activity.durationS),
    distanceKm: activity.distanceM != null ? (Number(activity.distanceM) / 1000).toFixed(1) : null,
  };

  if (includeLaps) {
    const laps = await db
      .select()
      .from(activityLaps)
      .where(eq(activityLaps.activityId, activityId))
      .orderBy(activityLaps.lapIndex);

    result.laps = laps.map((l) => ({
      ...l,
      durationFormatted: formatDuration(l.durationS),
      distanceKm: l.distanceM != null ? (Number(l.distanceM) / 1000).toFixed(1) : null,
    }));
  }

  return { ok: true, ...result };
}

