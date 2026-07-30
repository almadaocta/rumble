import { z } from 'zod';
import { PLAN_ACTIONS, TRAINING_PHASES, SESSION_TYPES } from './vocabularies.js';
import { PlanIntervals } from '../plans/plan-interval.js';
import { db } from '../../db/client.js';
import { trainingPlans, planSessions } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';
import { utcDateString } from '../../lib/format.js';

const SessionInput = z.object({
  scheduled_date: z.string(),
  session_type: z.enum(SESSION_TYPES),
  title: z.string(),
  description: z.string().optional(),
  target_tss: z.number().optional(),
  target_duration_min: z.number().optional(),
  target_if: z.number().optional(),
  // A real shape, not z.array(z.unknown()): these are read back by the Wahoo
  // pusher, and an interval with the wrong field names stores fine, lists fine,
  // and becomes a silently wrong workout on the athlete's device.
  intervals: PlanIntervals.optional(),
});

const UpdatePlanArgs = z.object({
  action: z.enum(PLAN_ACTIONS),
  plan_id: z.string().optional(),
  name: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  phase: z.enum(TRAINING_PHASES).optional(),
  methodology: z.string().optional(),
  weekly_tss_target: z.number().optional(),
  weekly_hours_target: z.number().optional(),
  notes: z.string().optional(),
  sessions: z.array(SessionInput).optional(),
});

function truncate(value: string | undefined, max: number): string | undefined {
  return value ? value.slice(0, max) : value;
}

/**
 * Maps the tool's session payload onto planSessions rows.
 *
 * Shared by the create and add_sessions branches, whose mappings differ only in
 * where planId comes from. One function so a new session field lands in both;
 * adding it to only one is silent data loss.
 */
function toSessionRows(
  sessions: z.infer<typeof SessionInput>[],
  planId: string,
  athleteId: string,
) {
  return sessions.map((s) => ({
    planId,
    athleteId,
    scheduledDate: s.scheduled_date,
    sessionType: truncate(s.session_type, 20)!,
    title: truncate(s.title, 200)!,
    description: s.description,
    targetTss: s.target_tss,
    targetDurationMin: s.target_duration_min,
    targetIf: s.target_if,
    intervals: s.intervals,
  }));
}

export async function updateTrainingPlan(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const params = UpdatePlanArgs.parse(args);

  if (params.action === 'create') {
    await db
      .update(trainingPlans)
      .set({ isActive: false })
      .where(and(eq(trainingPlans.athleteId, athleteId), eq(trainingPlans.isActive, true)));

    const [plan] = await db
      .insert(trainingPlans)
      .values({
        athleteId,
        name: truncate(params.name, 200) || 'Training Plan',
        startDate: params.start_date || utcDateString(),
        endDate: params.end_date,
        phase: truncate(params.phase, 100),
        methodology: truncate(params.methodology, 100),
        weeklyTssTarget: params.weekly_tss_target,
        weeklyHoursTarget: params.weekly_hours_target,
        notes: params.notes,
        isActive: true,
      })
      .returning();

    let sessionCount = 0;
    if (params.sessions?.length) {
      const sessionRows = toSessionRows(params.sessions, plan.id, athleteId);
      await db.insert(planSessions).values(sessionRows);
      sessionCount = sessionRows.length;
    }


    return {
      ok: true,
      plan_id: plan.id,
      name: plan.name,
      phase: plan.phase,
      sessions_added: sessionCount,
    };
  }

  if (params.action === 'add_sessions') {
    if (!params.plan_id) return { ok: false, error: "add_sessions requires 'plan_id'" };
    if (!params.sessions?.length) {
      return {
        ok: false,
        error:
          "add_sessions requires a non-empty 'sessions' array, but none was received. If you're writing a lot of sessions, split them into several smaller add_sessions calls (e.g. one per week) rather than one large call — a single call risks the output being cut off before the sessions array is reached.",
      };
    }

    const plan = await db
      .select()
      .from(trainingPlans)
      .where(and(eq(trainingPlans.id, params.plan_id), eq(trainingPlans.athleteId, athleteId)))
      .limit(1);

    if (!plan[0]) return { ok: false, error: `No plan found for plan_id "${params.plan_id}"` };

    const sessionRows = toSessionRows(params.sessions, params.plan_id, athleteId);

    await db.insert(planSessions).values(sessionRows);

    return {
      ok: true,
      plan_id: params.plan_id,
      sessions_added: sessionRows.length,
    };
  }

  if (params.action === 'update') {
    if (!params.plan_id) return { ok: false, error: "update requires 'plan_id'" };

    // Every field the tool schema declares has to be handled here: the model
    // offers what the schema advertises and takes an `ok` as confirmation it
    // applied, so a field accepted and dropped is a lie the athlete acts on.
    //
    // `!= null` rather than truthiness on the numeric targets — a weekly TSS or
    // hours target of 0 is a deliberate rest week, and truthiness discards it as
    // though the field were omitted. `notes` likewise, for a different reason:
    // '' is how the model clears a note, which truthiness reads as "omitted",
    // leaving the old one in place.
    //
    // The remaining string fields keep truthiness deliberately. A plan cannot
    // hold an empty name, phase, methodology or date, so '' there is a
    // malformed call, not an instruction to blank the column.
    const updates: Record<string, unknown> = {};
    if (params.name) updates.name = truncate(params.name, 200);
    if (params.phase) updates.phase = truncate(params.phase, 100);
    if (params.methodology) updates.methodology = truncate(params.methodology, 100);
    if (params.start_date) updates.startDate = params.start_date;
    if (params.end_date) updates.endDate = params.end_date;
    if (params.weekly_tss_target != null) updates.weeklyTssTarget = params.weekly_tss_target;
    if (params.weekly_hours_target != null) updates.weeklyHoursTarget = params.weekly_hours_target;
    if (params.notes != null) updates.notes = params.notes;

    // .returning() so a no-match is distinguishable from a real update. The
    // WHERE is athlete-scoped, which means an unknown plan_id — or someone
    // else's plan — matches zero rows; without checking, that reports ok:true
    // and the model tells the athlete "done" while nothing changed. The
    // add_sessions branch checks ownership up front instead.
    const updated = await db
      .update(trainingPlans)
      .set(updates)
      .where(and(eq(trainingPlans.id, params.plan_id), eq(trainingPlans.athleteId, athleteId)))
      .returning({ id: trainingPlans.id });

    if (updated.length === 0) {
      return { ok: false, error: `No plan found for plan_id "${params.plan_id}"` };
    }

    return { ok: true, plan_id: params.plan_id };
  }

  // Unreachable: `action` is a zod enum of exactly these three, so a fourth
  // value never survives the parse above. The `never` assignment is what makes
  // that worth writing — adding a case to the enum without a branch for it is a
  // compile error here, where a runtime "Unknown action" string would just be
  // something for the model to puzzle over.
  const unhandled: never = params.action;
  throw new Error(`Unhandled action: ${String(unhandled)}`);
}
