import { z } from 'zod';
import { db } from '../../db/client.js';
import { nutritionLogs } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';
import { MEAL_TYPES, CONFIDENCE_TIERS, type ConfidenceTier } from './vocabularies.js';

const ConfidenceTierSchema = z
  .number()
  .int()
  .refine((n): n is ConfidenceTier => (CONFIDENCE_TIERS as readonly number[]).includes(n), {
    message: `must be one of: ${CONFIDENCE_TIERS.join(', ')}`,
  });

const UpdateNutritionLogArgs = z.object({
  id: z.string().min(1),
  meal_type: z.enum(MEAL_TYPES).optional(),
  description: z.string().min(1).optional(),
  calories: z.number().optional(),
  carbs_g: z.number().optional(),
  protein_g: z.number().optional(),
  fat_g: z.number().optional(),
  confidence_tier: ConfidenceTierSchema.optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Correct a previously-logged meal — the athlete misspoke, the coach mis-estimated, or the date was wrong. */
export async function updateNutritionLog(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const { id, meal_type, description, calories, carbs_g, protein_g, fat_g, confidence_tier, date } =
    UpdateNutritionLogArgs.parse(args);

  const updates: Partial<typeof nutritionLogs.$inferInsert> = {};
  if (meal_type !== undefined) updates.mealType = meal_type;
  if (description !== undefined) updates.description = description;
  if (calories !== undefined) updates.calories = calories;
  if (carbs_g !== undefined) updates.carbsG = carbs_g;
  if (protein_g !== undefined) updates.proteinG = protein_g;
  if (fat_g !== undefined) updates.fatG = fat_g;
  if (confidence_tier !== undefined) updates.confidenceTier = confidence_tier;
  if (date !== undefined) updates.date = date;

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: 'No fields to update — provide at least one field besides id.' };
  }

  const [updated] = await db
    .update(nutritionLogs)
    .set(updates)
    .where(and(eq(nutritionLogs.id, id), eq(nutritionLogs.athleteId, athleteId)))
    .returning();

  if (!updated) {
    return { ok: false, error: `No nutrition log found with id ${id}.` };
  }

  return {
    ok: true,
    id: updated.id,
    date: updated.date,
    meal_type: updated.mealType ?? undefined,
    description: updated.description,
    macros: {
      calories: updated.calories,
      carbs_g: updated.carbsG,
      protein_g: updated.proteinG,
      fat_g: updated.fatG,
    },
    confidence_tier: updated.confidenceTier,
  };
}
