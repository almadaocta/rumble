import { z } from 'zod';
import { db } from '../../db/client.js';
import { nutritionLogs } from '../../db/schema.js';
import type { ToolFailure } from './tool-result.js';
import { utcDateString } from '../../lib/format.js';
import { MEAL_TYPES, CONFIDENCE_TIERS, type ConfidenceTier } from './vocabularies.js';
import { findDuplicateNutritionLog } from '../nutrition/nutrition.service.js';

/**
 * `.refine` with a type predicate rather than z.union([z.literal(1), ...]):
 * zod 3 has no way to build a literal union from a tuple, and restating the
 * members is exactly the drift this constant exists to prevent. The predicate
 * narrows the parsed output to ConfidenceTier all the same.
 */
const ConfidenceTierSchema = z
  .number()
  .int()
  .refine((n): n is ConfidenceTier => (CONFIDENCE_TIERS as readonly number[]).includes(n), {
    message: `must be one of: ${CONFIDENCE_TIERS.join(', ')}`,
  });

const LogMealArgs = z.object({
  meal_type: z.enum(MEAL_TYPES).optional(),
  description: z.string().min(1),
  calories: z.number().optional(),
  carbs_g: z.number().optional(),
  protein_g: z.number().optional(),
  fat_g: z.number().optional(),
  confidence_tier: ConfidenceTierSchema.optional().default(3),
});

/**
 * What logMeal returns when it actually logs something.
 *
 * Exported, and named in logMeal's return type, because the chat fast path
 * formats a confirmation from it. Naming it here is what makes a change to
 * these fields a compile error there; a hand-copied shape reached through
 * `as unknown as` compiles cleanly and produces a malformed confirmation at
 * runtime. With the union below, `if (!outcome.ok) return` is all the narrowing
 * the caller needs.
 */
// A type alias, not an interface: interfaces get no implicit index signature,
// so an interface here would not be assignable to ToolSuccess's `[key: string]`.
export type LogMealSuccess = {
  ok: true;
  id: string;
  date: string;
  meal_type: string | undefined;
  description: string;
  macros: {
    calories: number | null;
    carbs_g: number | null;
    protein_g: number | null;
    fat_g: number | null;
  };
  confidence_tier: number;
  note?: string;
};

export async function logMeal(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<LogMealSuccess | ToolFailure> {
  const {
    meal_type,
    description,
    calories,
    carbs_g,
    protein_g,
    fat_g,
    confidence_tier,
  } = LogMealArgs.parse(args);

  const today = utcDateString();

  const duplicate = await findDuplicateNutritionLog(athleteId, today, description);
  if (duplicate) {
    return {
      ok: false,
      error:
        `A meal with this description is already logged today (id ${duplicate.id}` +
        `${duplicate.mealType ? `, ${duplicate.mealType}` : ''}): "${duplicate.description}". ` +
        'If this is meant to change that entry, call update_nutrition_log with that id instead of logging again. ' +
        'If the athlete really did eat the same thing twice, describe it distinctly (e.g. add a time or portion note) and log again.',
      existing_id: duplicate.id,
    };
  }

  const [inserted] = await db
    .insert(nutritionLogs)
    .values({
      athleteId,
      date: today,
      mealType: meal_type,
      description,
      calories,
      carbsG: carbs_g,
      proteinG: protein_g,
      fatG: fat_g,
      confidenceTier: confidence_tier,
      source: 'chat',
    })
    .returning();

  const success: LogMealSuccess = {
    ok: true,
    id: inserted.id,
    date: today,
    meal_type,
    description,
    macros: {
      calories: calories ?? null,
      carbs_g: carbs_g ?? null,
      protein_g: protein_g ?? null,
      fat_g: fat_g ?? null,
    },
    confidence_tier,
    note:
      confidence_tier === 3
        ? 'Estimated from description — accuracy is approximate. For better tracking, weigh food or photograph nutrition labels.'
        : undefined,
  };

  return success;
}
