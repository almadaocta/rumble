/**
 * Today's macro totals, as the Nutrition tab reads them.
 *
 * The `logged` flag is the interesting part: it distinguishes "nothing logged
 * today" from "logged, and it happened to be zero calories", and the tab renders
 * those differently — a nudge to log versus a real total. Getting that from
 * `calories > 0` instead of row presence would make a logged black coffee look
 * like an empty day.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { nutritionLogs } from '../../db/schema.js';
import { utcDateString } from '../../lib/format.js';
import { nutritionController } from './nutrition.controller.js';

function buildTestApp(athleteId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.athleteId = athleteId;
    next();
  });
  app.use('/api/nutrition', nutritionController);
  return app;
}

// Frozen: the fixture dates and the controller both call utcDateString(), so
// an unfrozen run that crosses midnight UTC files "today's" meals under
// yesterday. Mid-month and mid-day, so neither rolls over.
const FIXED_NOW = new Date('2026-05-13T10:00:00Z');
const TODAY = utcDateString(FIXED_NOW);

function yesterday(): string {
  const d = new Date(FIXED_NOW);
  d.setDate(d.getDate() - 1);
  return utcDateString(d);
}

function meal(athleteId: string, overrides: Record<string, unknown> = {}) {
  return {
    athleteId,
    date: TODAY,
    description: 'oats and banana',
    calories: 450,
    carbsG: 80,
    proteinG: 12,
    fatG: 8,
    confidenceTier: 3,
    source: 'chat',
    ...overrides,
  };
}

let athleteId: string;
let app: express.Express;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  migrateTestDb();
  athleteId = await seedAthlete('Nutrition Athlete');
  app = buildTestApp(athleteId);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/nutrition/today', () => {
  it('reports an empty day with logged:false and null totals', async () => {
    const res = await request(app).get('/api/nutrition/today');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      logged: false,
      calories: null,
      carbsG: null,
      proteinG: null,
      fatG: null,
      meals: [],
    });
  });

  it('sums the day\'s macros', async () => {
    await db.insert(nutritionLogs).values([
      meal(athleteId, { mealType: 'breakfast', calories: 450, carbsG: 80, proteinG: 12, fatG: 8 }),
      meal(athleteId, { mealType: 'lunch', calories: 700, carbsG: 70, proteinG: 45, fatG: 22 }),
    ]);

    const res = await request(app).get('/api/nutrition/today');

    expect(res.body).toMatchObject({
      logged: true,
      calories: 1150,
      carbsG: 150,
      proteinG: 57,
      fatG: 30,
    });
    expect(res.body.meals).toHaveLength(2);
  });

  it('says logged:true for a zero-calorie entry rather than reading as an empty day', async () => {
    // A logged black coffee is not the same as having logged nothing, and the
    // tab shows a different thing for each.
    await db.insert(nutritionLogs).values(
      meal(athleteId, { description: 'black coffee', calories: 0, carbsG: 0, proteinG: 0, fatG: 0 }),
    );

    const res = await request(app).get('/api/nutrition/today');

    expect(res.body.logged).toBe(true);
    expect(res.body.calories).toBe(0);
  });

  it('treats a meal with unknown macros as zero in the totals, not NaN', async () => {
    await db.insert(nutritionLogs).values([
      meal(athleteId, { calories: 450, carbsG: 80, proteinG: 12, fatG: 8 }),
      meal(athleteId, { description: 'handful of nuts', calories: null, carbsG: null, proteinG: null, fatG: null }),
    ]);

    const res = await request(app).get('/api/nutrition/today');

    expect(res.body.calories).toBe(450);
    expect(res.body.meals).toHaveLength(2);
  });

  it('keeps per-meal nulls as null rather than coercing them to zero', async () => {
    // The totals coalesce; the individual rows must not, or the tab claims the
    // athlete ate a meal with zero of everything.
    await db.insert(nutritionLogs).values(
      meal(athleteId, { description: 'handful of nuts', calories: null, carbsG: null, proteinG: null, fatG: null }),
    );

    const [row] = (await request(app).get('/api/nutrition/today')).body.meals;

    expect(row).toMatchObject({ calories: null, carbsG: null, proteinG: null, fatG: null });
  });

  it('flags a description-based estimate but not a weighed entry', async () => {
    await db.insert(nutritionLogs).values([
      meal(athleteId, { description: 'guessed', confidenceTier: 3 }),
      meal(athleteId, { description: 'weighed', confidenceTier: 1 }),
    ]);

    const { meals } = (await request(app).get('/api/nutrition/today')).body;
    const byDescription = Object.fromEntries(
      meals.map((m: { description: string; estimated: boolean }) => [m.description, m.estimated]),
    );

    expect(byDescription).toEqual({ guessed: true, weighed: false });
  });

  it('ignores yesterday\'s log', async () => {
    await db.insert(nutritionLogs).values(meal(athleteId, { date: yesterday(), calories: 3000 }));

    const res = await request(app).get('/api/nutrition/today');

    expect(res.body.logged).toBe(false);
    expect(res.body.meals).toEqual([]);
  });

  it('never returns another athlete\'s meals', async () => {
    const other = await seedAthlete('Someone Else');
    await db.insert(nutritionLogs).values(meal(other, { description: 'their lunch' }));

    const res = await request(app).get('/api/nutrition/today');

    expect(res.body.logged).toBe(false);
    expect(res.body.meals).toEqual([]);
  });
});

/**
 * The same rows are read twice: this controller renders them for the UI, and
 * get_nutrition_log renders them for the coach. They disagreed about a logged
 * zero — the UI showed "0 kcal" while the coach was told the value was unknown.
 */
describe('agreement with the get_nutrition_log tool', () => {
  it('reports a logged zero as zero, the same way the tool now does', async () => {
    await db.insert(nutritionLogs).values(
      meal(athleteId, { description: 'black coffee', calories: 0, carbsG: 0, proteinG: 0, fatG: 0 }),
    );

    const { getNutritionLog } = await import('../tools/get-nutrition-log.js');
    const fromTool = await getNutritionLog({}, athleteId);
    const fromApi = (await request(app).get('/api/nutrition/today')).body;

    // Narrow on `ok` rather than casting the union: ToolOutcome is a
    // discriminated union precisely so callers don't have to assert.
    expect(fromTool.ok).toBe(true);
    if (!fromTool.ok) return;

    const [toolMeal] = fromTool.meals as Array<{ calories: number | null }>;
    expect(toolMeal.calories).toBe(0);
    expect(fromApi.meals[0].calories).toBe(0);
    // The point is the agreement, not either value on its own.
    expect(toolMeal.calories).toBe(fromApi.meals[0].calories);
  });
});
