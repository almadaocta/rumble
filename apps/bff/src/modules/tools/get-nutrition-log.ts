import { z } from 'zod';
import { db } from '../../db/client.js';
import { nutritionLogs } from '../../db/schema.js';
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';
import { utcDateString } from '../../lib/format.js';

const GetNutritionLogArgs = z.object({
  date: z.string().optional(),
  days: z.number().optional().default(1),
});

export async function getNutritionLog(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const { date, days } = GetNutritionLogArgs.parse(args);

  const targetDate = date || utcDateString();

  if (days === 1) {
    const logs = await db
      .select()
      .from(nutritionLogs)
      .where(and(eq(nutritionLogs.athleteId, athleteId), eq(nutritionLogs.date, targetDate)))
      .orderBy(nutritionLogs.loggedAt);

    const totals = logs.reduce(
      (acc, log) => ({
        calories: acc.calories + Number(log.calories ?? 0),
        carbs_g: acc.carbs_g + Number(log.carbsG ?? 0),
        protein_g: acc.protein_g + Number(log.proteinG ?? 0),
        fat_g: acc.fat_g + Number(log.fatG ?? 0),
      }),
      { calories: 0, carbs_g: 0, protein_g: 0, fat_g: 0 },
    );

    return {
      ok: true,
      date: targetDate,
      meals: logs.map((l) => ({
        meal_type: l.mealType,
        description: l.description,
        // `!= null`, not truthiness: a logged 0 is a real measurement — a black
        // coffee, a zero-fat meal — and truthiness reports it to the coach as
        // unknown. nutrition.controller.ts renders the same rows for the UI and
        // has always used `!= null`, so the two disagreed about the same meal.
        calories: l.calories != null ? Number(l.calories) : null,
        carbs_g: l.carbsG != null ? Number(l.carbsG) : null,
        protein_g: l.proteinG != null ? Number(l.proteinG) : null,
        fat_g: l.fatG != null ? Number(l.fatG) : null,
        confidence_tier: l.confidenceTier,
        source: l.source,
      })),
      totals,
      meal_count: logs.length,
    };
  }

  const startDate = new Date(targetDate);
  startDate.setDate(startDate.getDate() - days + 1);
  const startStr = utcDateString(startDate);

  const dailySummary = await db
    .select({
      date: nutritionLogs.date,
      calories: sql<string>`SUM(${nutritionLogs.calories})`,
      carbs_g: sql<string>`SUM(${nutritionLogs.carbsG})`,
      protein_g: sql<string>`SUM(${nutritionLogs.proteinG})`,
      fat_g: sql<string>`SUM(${nutritionLogs.fatG})`,
      meal_count: sql<string>`COUNT(*)`,
    })
    .from(nutritionLogs)
    .where(
      and(
        eq(nutritionLogs.athleteId, athleteId),
        gte(nutritionLogs.date, startStr),
        lte(nutritionLogs.date, targetDate),
      ),
    )
    .groupBy(nutritionLogs.date)
    .orderBy(desc(nutritionLogs.date));

  return {
    ok: true,
    period: `${startStr} to ${targetDate}`,
    daily_summary: dailySummary.map((d) => ({
      date: d.date,
      calories: Math.round(Number(d.calories ?? 0)),
      carbs_g: Math.round(Number(d.carbs_g ?? 0)),
      protein_g: Math.round(Number(d.protein_g ?? 0)),
      fat_g: Math.round(Number(d.fat_g ?? 0)),
      meal_count: Number(d.meal_count),
    })),
  };
}
