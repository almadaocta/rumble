import { z } from 'zod';
import { db } from '../../db/client.js';
import { planSessions } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';

const LogFeedbackArgs = z.object({
  session_id: z.string(),
  rpe: z.number(),
  notes: z.string().optional(),
  completed: z.boolean().optional().default(true),
});

export async function logSessionFeedback(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const { session_id, rpe, notes, completed } = LogFeedbackArgs.parse(args);

  const session = await db
    .select()
    .from(planSessions)
    .where(and(eq(planSessions.id, session_id), eq(planSessions.athleteId, athleteId)))
    .limit(1);

  if (!session[0]) {
    return { ok: false, error: 'Session not found or does not belong to this athlete' };
  }

  const [updated] = await db
    .update(planSessions)
    .set({
      feedbackRpe: rpe,
      feedbackNotes: notes,
      completed,
    })
    .where(and(eq(planSessions.id, session_id), eq(planSessions.athleteId, athleteId)))
    .returning();

  return {
    ok: true,
    session: {
      id: updated.id,
      title: updated.title,
      session_type: updated.sessionType,
      scheduled_date: updated.scheduledDate,
      completed: updated.completed,
      rpe: updated.feedbackRpe,
      notes: updated.feedbackNotes,
    },
  };
}
