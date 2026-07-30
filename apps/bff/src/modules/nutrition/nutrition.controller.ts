/**
 * Read API for today's nutrition totals.
 *
 * The HTTP half of nutrition; modules/tools owns the log-meal and
 * get-nutrition-log handlers the coach calls. Kept out of the chat module
 * because a nutrition resource behind /api/chat is only discoverable by
 * whoever put it there.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../../db/client.js';
import { nutritionLogs } from '../../db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
import { resolveAthleteId } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/error-handler.js';
import { utcDateString } from '../../lib/format.js';

export const nutritionController: Router = Router();
nutritionController.use(resolveAthleteId);

nutritionController.get('/today', asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;
  const today = utcDateString();

  const logs = await db
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
    .orderBy(desc(nutritionLogs.loggedAt));

  if (logs.length === 0) {
    return res.json({ logged: false, calories: null, carbsG: null, proteinG: null, fatG: null, meals: [] });
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
