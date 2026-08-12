import { z } from 'zod';
import { db } from '../../db/client.js';
import { nutritionLogs } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';

const DeleteNutritionLogArgs = z.object({
  id: z.string().min(1),
});

/** Remove a logged meal — a duplicate, a mis-log, or something the athlete never actually ate. */
export async function deleteNutritionLog(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const { id } = DeleteNutritionLogArgs.parse(args);

  const [deleted] = await db
    .delete(nutritionLogs)
    .where(and(eq(nutritionLogs.id, id), eq(nutritionLogs.athleteId, athleteId)))
    .returning();

  if (!deleted) {
    return { ok: false, error: `No nutrition log found with id ${id}.` };
  }

  return {
    ok: true,
    id: deleted.id,
    date: deleted.date,
    description: deleted.description,
  };
}
