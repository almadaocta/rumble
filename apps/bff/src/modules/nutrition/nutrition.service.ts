/**
 * Duplicate detection shared by anything that inserts a nutrition log.
 *
 * Lives here rather than inside modules/tools/log-meal.ts because it is about
 * the nutrition_logs table's shape, not about being a Claude tool — a future
 * write path (REST, import) wants the same check without importing a tool
 * handler.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { nutritionLogs } from '../../db/schema.js';

export interface DuplicateNutritionLog {
  id: string;
  description: string;
  mealType: string | null;
}

/**
 * Same athlete, same day, same description (trimmed, case-insensitive).
 *
 * That's the shape of an accidental double-log (the athlete repeats
 * themselves in chat, or a retried tool call re-submits) — not a legitimate
 * second helping, which would normally be described differently or fall on a
 * different meal_type. Scoped to the day, not all-time, so "oatmeal" logged
 * on two different mornings is never flagged.
 */
export async function findDuplicateNutritionLog(
  athleteId: string,
  date: string,
  description: string,
): Promise<DuplicateNutritionLog | null> {
  const normalized = description.trim().toLowerCase();

  const [dup] = await db
    .select({
      id: nutritionLogs.id,
      description: nutritionLogs.description,
      mealType: nutritionLogs.mealType,
    })
    .from(nutritionLogs)
    .where(
      and(
        eq(nutritionLogs.athleteId, athleteId),
        eq(nutritionLogs.date, date),
        sql`lower(trim(${nutritionLogs.description})) = ${normalized}`,
      ),
    )
    .limit(1);

  return dup ?? null;
}
