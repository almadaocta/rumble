/**
 * HTTP surface for nutrition: reads today's totals, and lets a caller
 * directly edit or remove an already-logged entry by id.
 *
 * modules/tools still owns log-meal and get-nutrition-log — those are the
 * coach's chat-driven read/add path. PATCH/DELETE here exist for direct,
 * non-chat correction (a UI edit control, a manual fix) and go through the
 * same nutrition_logs rows, scoped to the requesting athlete the same way
 * the tool handlers are. Kept out of the chat module because a nutrition
 * resource behind /api/chat is only discoverable by whoever put it there.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { nutritionLogs, activities, athletes } from '../../db/schema.js';
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import { resolveAthleteId } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/error-handler.js';
import { utcDateString } from '../../lib/format.js';
import { computeTarget } from '../metrics/bmr.js';

export const nutritionController: Router = Router();
nutritionController.use(resolveAthleteId);

nutritionController.get('/today', asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;
  const today = utcDateString();

  // today's start and end in UTC for activity timestamp range
  const todayStart = new Date(`${today}T00:00:00.000Z`);
  const todayEnd = new Date(`${today}T23:59:59.999Z`);

  const [logs, burnedRows, athleteRows] = await Promise.all([
    db
      .select({
        id: nutritionLogs.id,
        mealType: nutritionLogs.mealType,
        description: nutritionLogs.description,
        calories: nutritionLogs.calories,
        carbsG: nutritionLogs.carbsG,
        proteinG: nutritionLogs.proteinG,
        fatG: nutritionLogs.fatG,
        confidenceTier: nutritionLogs.confidenceTier,
        loggedAt: nutritionLogs.loggedAt,
      })
      .from(nutritionLogs)
      .where(and(eq(nutritionLogs.athleteId, athleteId), eq(nutritionLogs.date, today)))
      .orderBy(desc(nutritionLogs.loggedAt)),

    db
      .select({ totalCalories: sql<string>`COALESCE(SUM(${activities.calories}), 0)` })
      .from(activities)
      .where(
        and(
          eq(activities.athleteId, athleteId),
          gte(activities.startedAt, todayStart),
          lte(activities.startedAt, todayEnd),
        ),
      ),

    db
      .select({
        weightKg: athletes.weightKg,
        heightCm: athletes.heightCm,
        age: athletes.age,
        sex: athletes.sex,
        dailyCalorieAdjustment: athletes.dailyCalorieAdjustment,
      })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1),
  ]);

  const burned = Math.round(Number(burnedRows[0]?.totalCalories ?? 0));
  const athlete = athleteRows[0];
  const target = athlete
    ? computeTarget(
        { weightKg: athlete.weightKg, heightCm: athlete.heightCm, age: athlete.age, sex: athlete.sex },
        athlete.dailyCalorieAdjustment ?? 0,
      )
    : null;
  const calorieAdjustment = athlete?.dailyCalorieAdjustment ?? 0;

  if (logs.length === 0) {
    return res.json({
      logged: false,
      calories: null,
      carbsG: null,
      proteinG: null,
      fatG: null,
      burned,
      target,
      calorieAdjustment,
      meals: [],
    });
  }

  const totals = logs.reduce<{ calories: number; carbsG: number; proteinG: number; fatG: number }>(
    (acc, l) => ({
      calories: acc.calories + Number(l.calories ?? 0),
      carbsG: acc.carbsG + Number(l.carbsG ?? 0),
      proteinG: acc.proteinG + Number(l.proteinG ?? 0),
      fatG: acc.fatG + Number(l.fatG ?? 0),
    }),
    { calories: 0, carbsG: 0, proteinG: 0, fatG: 0 },
  );

  res.json({
    logged: true,
    calories: Math.round(totals.calories),
    carbsG: Math.round(totals.carbsG),
    proteinG: Math.round(totals.proteinG),
    fatG: Math.round(totals.fatG),
    burned,
    target,
    calorieAdjustment,
    meals: logs.map((l) => ({
      id: l.id,
      mealType: l.mealType,
      description: l.description,
      calories: l.calories != null ? Math.round(Number(l.calories)) : null,
      carbsG: l.carbsG != null ? Math.round(Number(l.carbsG)) : null,
      proteinG: l.proteinG != null ? Math.round(Number(l.proteinG)) : null,
      fatG: l.fatG != null ? Math.round(Number(l.fatG)) : null,
      estimated: l.confidenceTier >= 3,
    })),
  });
}));

const patchNutritionLogSchema = z
  .object({
    mealType: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    calories: z.number().nullable().optional(),
    carbsG: z.number().nullable().optional(),
    proteinG: z.number().nullable().optional(),
    fatG: z.number().nullable().optional(),
    confidenceTier: z.number().int().min(1).max(3).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

nutritionController.patch('/:id', asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;

  const parsed = patchNutritionLogSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  }
  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const [updated] = await db
    .update(nutritionLogs)
    .set(parsed.data)
    .where(and(eq(nutritionLogs.id, req.params.id), eq(nutritionLogs.athleteId, athleteId)))
    .returning();

  if (!updated) return res.status(404).json({ error: 'Nutrition log not found' });

  res.json({
    id: updated.id,
    date: updated.date,
    mealType: updated.mealType,
    description: updated.description,
    calories: updated.calories != null ? Number(updated.calories) : null,
    carbsG: updated.carbsG != null ? Number(updated.carbsG) : null,
    proteinG: updated.proteinG != null ? Number(updated.proteinG) : null,
    fatG: updated.fatG != null ? Number(updated.fatG) : null,
    confidenceTier: updated.confidenceTier,
  });
}));

nutritionController.delete('/:id', asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;

  const deleted = await db
    .delete(nutritionLogs)
    .where(and(eq(nutritionLogs.id, req.params.id), eq(nutritionLogs.athleteId, athleteId)))
    .returning();

  if (deleted.length === 0) return res.status(404).json({ error: 'Nutrition log not found' });

  res.json({ ok: true, id: req.params.id });
}));
