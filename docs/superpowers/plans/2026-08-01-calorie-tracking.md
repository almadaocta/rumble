# Calorie Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded calorie targets with a dynamic system where Target = BMR + daily_calorie_adjustment, Burned = today's activity calories from Wahoo, and the UI shows Consumed / Burned / Target / Left.

**Architecture:** Add `dailyCalorieAdjustment` to the `athletes` schema (deficit = negative, surplus = positive, 0 = maintenance). A pure `computeBmr` function uses Mifflin-St Jeor with the athlete's age/height/weight/sex. The `GET /api/nutrition/today` endpoint is extended to return `burned` (today's activity calories) and `target` (computed BMR + adjustment). The orchestrator gains the ability to set the adjustment via `update_athlete_profile`. The UI replaces hardcoded constants with API values.

**Tech Stack:** TypeScript, Drizzle ORM, SQLite, Vitest, React 19, Tailwind v4

---

## File Map

| File | Change |
|------|--------|
| `apps/bff/src/db/schema.ts` | Add `dailyCalorieAdjustment` column to `athletes` |
| `apps/bff/drizzle/` | New migration SQL file |
| `apps/bff/src/modules/metrics/bmr.ts` | **New** — pure `computeBmr()` and `computeTarget()` functions |
| `apps/bff/src/modules/metrics/bmr.test.ts` | **New** — unit tests for BMR/target math |
| `apps/bff/src/modules/nutrition/nutrition.controller.ts` | Extend `/today` response with `burned` and `target` |
| `apps/bff/src/modules/nutrition/nutrition.controller.test.ts` | Tests for new response fields |
| `apps/bff/src/modules/tools/update-athlete-profile.ts` | Add `daily_calorie_adjustment` to settable fields |
| `apps/bff/src/modules/tools/get-nutrition-log.ts` | Add `calorie_target`, `calories_burned`, `net_calories` to single-day response |
| `apps/bff/src/modules/tools/tool-registry.ts` | Update `update_athlete_profile` and `get_nutrition_log` descriptions |
| `apps/web/src/lib/api-types.ts` | Extend `NutritionToday` with `burned`, `target`, `calorieAdjustment` |
| `apps/web/src/components/NutritionTab.tsx` | Replace hardcoded constants, add Burned stat |

---

## Task 1: Add `dailyCalorieAdjustment` to the athletes schema and migration

**Files:**
- Modify: `apps/bff/src/db/schema.ts:16-32`
- Create: `apps/bff/drizzle/0002_calorie_adjustment.sql`

- [ ] **Step 1: Add the column to the schema**

In `apps/bff/src/db/schema.ts`, add after `coachingTone`:

```typescript
  dailyCalorieAdjustment: integer('daily_calorie_adjustment').notNull().default(0),
```

The full `athletes` table definition becomes:

```typescript
export const athletes = sqliteTable('athletes', {
  id: uuidPk(),
  name: text('name').notNull(),
  email: text('email'),
  timezone: text('timezone').notNull().default('Europe/Madrid'),
  ftp: integer('ftp'),
  ftpUpdatedAt: timestamptz('ftp_updated_at'),
  weightKg: real('weight_kg'),
  heightCm: integer('height_cm'),
  age: integer('age'),
  sex: text('sex'),
  availableHoursWeek: real('available_hours_week'),
  experienceLevel: text('experience_level'),
  primaryGoal: text('primary_goal'),
  coachingTone: integer('coaching_tone').notNull().default(5),
  dailyCalorieAdjustment: integer('daily_calorie_adjustment').notNull().default(0),
  createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
});
```

- [ ] **Step 2: Write the migration file**

Create `apps/bff/drizzle/0002_calorie_adjustment.sql`:

```sql
ALTER TABLE athletes ADD COLUMN daily_calorie_adjustment INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Run the migration against the dev database**

```bash
pnpm --filter bff db:migrate
```

Expected: Migration runs without error.

- [ ] **Step 4: Commit**

```bash
git add apps/bff/src/db/schema.ts apps/bff/drizzle/0002_calorie_adjustment.sql
git commit -m "feat: add dailyCalorieAdjustment column to athletes schema"
```

---

## Task 2: Pure BMR and target computation functions

**Files:**
- Create: `apps/bff/src/modules/metrics/bmr.ts`
- Create: `apps/bff/src/modules/metrics/bmr.test.ts`

Uses the **Mifflin-St Jeor** formula:
- Male: BMR = 10 × weight_kg + 6.25 × height_cm − 5 × age + 5
- Female: BMR = 10 × weight_kg + 6.25 × height_cm − 5 × age − 161
- Unknown sex: average of male and female

`computeTarget` = BMR + dailyCalorieAdjustment. Returns `null` if any required input is missing.

- [ ] **Step 1: Write the failing tests**

Create `apps/bff/src/modules/metrics/bmr.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeBmr, computeTarget } from './bmr.js';

describe('computeBmr', () => {
  it('computes male BMR correctly', () => {
    // 10×75 + 6.25×178 - 5×30 + 5 = 750 + 1112.5 - 150 + 5 = 1717.5 → 1718
    expect(computeBmr({ weightKg: 75, heightCm: 178, age: 30, sex: 'male' })).toBe(1718);
  });

  it('computes female BMR correctly', () => {
    // 10×60 + 6.25×165 - 5×28 - 161 = 600 + 1031.25 - 140 - 161 = 1330.25 → 1330
    expect(computeBmr({ weightKg: 60, heightCm: 165, age: 28, sex: 'female' })).toBe(1330);
  });

  it('averages male and female when sex is unknown', () => {
    const male = computeBmr({ weightKg: 75, heightCm: 178, age: 30, sex: 'male' })!;
    const female = computeBmr({ weightKg: 75, heightCm: 178, age: 30, sex: 'female' })!;
    const unknown = computeBmr({ weightKg: 75, heightCm: 178, age: 30, sex: null })!;
    expect(unknown).toBe(Math.round((male + female) / 2));
  });

  it('returns null when weight is missing', () => {
    expect(computeBmr({ weightKg: null, heightCm: 178, age: 30, sex: 'male' })).toBeNull();
  });

  it('returns null when height is missing', () => {
    expect(computeBmr({ weightKg: 75, heightCm: null, age: 30, sex: 'male' })).toBeNull();
  });

  it('returns null when age is missing', () => {
    expect(computeBmr({ weightKg: 75, heightCm: 178, age: null, sex: 'male' })).toBeNull();
  });
});

describe('computeTarget', () => {
  it('returns BMR when adjustment is 0 (maintenance)', () => {
    expect(computeTarget({ weightKg: 75, heightCm: 178, age: 30, sex: 'male' }, 0)).toBe(1718);
  });

  it('adds surplus correctly', () => {
    expect(computeTarget({ weightKg: 75, heightCm: 178, age: 30, sex: 'male' }, 300)).toBe(2018);
  });

  it('subtracts deficit correctly', () => {
    expect(computeTarget({ weightKg: 75, heightCm: 178, age: 30, sex: 'male' }, -500)).toBe(1218);
  });

  it('returns null when BMR cannot be computed', () => {
    expect(computeTarget({ weightKg: null, heightCm: 178, age: 30, sex: 'male' }, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
pnpm --filter bff test bmr
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement bmr.ts**

Create `apps/bff/src/modules/metrics/bmr.ts`:

```typescript
interface BiometricInputs {
  weightKg: number | null | undefined;
  heightCm: number | null | undefined;
  age: number | null | undefined;
  sex: string | null | undefined;
}

/**
 * Mifflin-St Jeor BMR in kcal/day.
 *
 * Male:   10×weight + 6.25×height − 5×age + 5
 * Female: 10×weight + 6.25×height − 5×age − 161
 * Unknown: average of male and female
 *
 * Returns null if any required input is missing.
 */
export function computeBmr(inputs: BiometricInputs): number | null {
  const { weightKg, heightCm, age, sex } = inputs;
  if (weightKg == null || heightCm == null || age == null) return null;

  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;

  if (sex === 'male') return Math.round(base + 5);
  if (sex === 'female') return Math.round(base - 161);
  // Unknown sex: average of both
  return Math.round((base + 5 + (base - 161)) / 2);
}

/**
 * Daily calorie target = BMR + adjustment.
 *
 * adjustment > 0: caloric surplus (muscle gain / fuelling)
 * adjustment < 0: caloric deficit (weight loss)
 * adjustment = 0: maintenance
 *
 * Returns null if BMR cannot be computed.
 */
export function computeTarget(inputs: BiometricInputs, dailyCalorieAdjustment: number): number | null {
  const bmr = computeBmr(inputs);
  if (bmr == null) return null;
  return bmr + dailyCalorieAdjustment;
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter bff test bmr
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/bff/src/modules/metrics/bmr.ts apps/bff/src/modules/metrics/bmr.test.ts
git commit -m "feat: add computeBmr and computeTarget pure functions (Mifflin-St Jeor)"
```

---

## Task 3: Extend `GET /api/nutrition/today` with burned and target

**Files:**
- Modify: `apps/bff/src/modules/nutrition/nutrition.controller.ts`
- Modify: `apps/bff/src/modules/nutrition/nutrition.controller.test.ts`

The endpoint needs to:
1. Query today's total activity calories for the athlete
2. Fetch the athlete's biometrics + `dailyCalorieAdjustment`
3. Compute `target` via `computeTarget`
4. Return `burned`, `target`, `calorieAdjustment` alongside existing fields

- [ ] **Step 1: Read the existing test file**

```bash
cat apps/bff/src/modules/nutrition/nutrition.controller.test.ts
```

Understand the test DB setup and seeding patterns before writing new tests.

- [ ] **Step 2: Write failing tests**

Add these tests to `apps/bff/src/modules/nutrition/nutrition.controller.test.ts` (read the file first to understand the exact setup — the tests below assume a pattern similar to other controller tests in the codebase):

```typescript
it('GET /api/nutrition/today returns burned calories from today activities', async () => {
  // Seed an activity for today with calories
  await db.insert(activities).values({
    id: randomUUID(),
    athleteId,
    externalId: 'test-burned-1',
    source: 'wahoo',
    type: 'ride',
    name: 'Morning Ride',
    startedAt: new Date(), // today
    durationS: 3600,
    calories: 650,
  });

  const res = await request(app).get('/api/nutrition/today');
  expect(res.status).toBe(200);
  expect(res.body.burned).toBe(650);
});

it('GET /api/nutrition/today returns target based on BMR when profile is complete', async () => {
  // Update athlete profile to have complete biometrics
  await db.update(athletes)
    .set({ weightKg: 75, heightCm: 178, age: 30, sex: 'male', dailyCalorieAdjustment: 0 })
    .where(eq(athletes.id, athleteId));

  const res = await request(app).get('/api/nutrition/today');
  expect(res.status).toBe(200);
  // Male, 75kg, 178cm, 30yo: 10*75 + 6.25*178 - 5*30 + 5 = 1718
  expect(res.body.target).toBe(1718);
  expect(res.body.calorieAdjustment).toBe(0);
});

it('GET /api/nutrition/today applies calorie adjustment to target', async () => {
  await db.update(athletes)
    .set({ weightKg: 75, heightCm: 178, age: 30, sex: 'male', dailyCalorieAdjustment: -500 })
    .where(eq(athletes.id, athleteId));

  const res = await request(app).get('/api/nutrition/today');
  expect(res.status).toBe(200);
  expect(res.body.target).toBe(1218); // 1718 - 500
  expect(res.body.calorieAdjustment).toBe(-500);
});

it('GET /api/nutrition/today returns null target when profile is incomplete', async () => {
  // Leave weight/height/age as null (default seeded athlete has no biometrics)
  const res = await request(app).get('/api/nutrition/today');
  expect(res.status).toBe(200);
  expect(res.body.target).toBeNull();
  expect(res.body.burned).toBe(0); // no activities today
});
```

- [ ] **Step 3: Run to confirm they fail**

```bash
pnpm --filter bff test nutrition.controller
```

Expected: FAIL — `burned`, `target`, `calorieAdjustment` not in response.

- [ ] **Step 4: Implement the changes**

Replace `apps/bff/src/modules/nutrition/nutrition.controller.ts` with:

```typescript
import { Router, type Request, type Response } from 'express';
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
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter bff test nutrition.controller
```

Expected: All tests pass.

- [ ] **Step 6: Run full suite**

```bash
pnpm --filter bff test
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/bff/src/modules/nutrition/nutrition.controller.ts apps/bff/src/modules/nutrition/nutrition.controller.test.ts
git commit -m "feat: add burned, target, calorieAdjustment to GET /api/nutrition/today"
```

---

## Task 4: Allow orchestrator to set `daily_calorie_adjustment`

**Files:**
- Modify: `apps/bff/src/modules/tools/update-athlete-profile.ts`
- Modify: `apps/bff/src/modules/tools/tool-registry.ts`

- [ ] **Step 1: Write a failing test**

Find the test file for `update-athlete-profile` or add to `tenant-isolation.test.ts`:

```typescript
it('updateAthleteProfile can set daily_calorie_adjustment', async () => {
  const { athleteId } = await seedAthlete(db);

  const result = await updateAthleteProfile({ daily_calorie_adjustment: -500 }, athleteId);

  expect(result.ok).toBe(true);
  expect((result as Record<string, unknown>).updated_fields).toContain('daily_calorie_adjustment');

  // Verify it was actually persisted
  const [row] = await db.select({ dailyCalorieAdjustment: athletes.dailyCalorieAdjustment })
    .from(athletes)
    .where(eq(athletes.id, athleteId));
  expect(row.dailyCalorieAdjustment).toBe(-500);
});
```

> Import `updateAthleteProfile` and `athletes` if not already in the test file.

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm --filter bff test tenant-isolation
```

Expected: FAIL — `daily_calorie_adjustment` not in the schema or update logic.

- [ ] **Step 3: Update the Zod schema and update logic**

In `apps/bff/src/modules/tools/update-athlete-profile.ts`, add `daily_calorie_adjustment` to the `ProfileUpdate` schema and the `setValues` mapping:

```typescript
const ProfileUpdate = z.object({
  weight_kg: z.number().optional(),
  height_cm: z.number().optional(),
  age: z.number().optional(),
  sex: z.enum(SEXES).optional(),
  available_hours_week: z.number().optional(),
  experience_level: z.enum(EXPERIENCE_LEVELS).optional(),
  primary_goal: z.enum(PRIMARY_GOALS).optional(),
  coaching_tone: z.number().optional(),
  daily_calorie_adjustment: z.number().int().optional(),
});
```

And in the `setValues` block, add:

```typescript
if (updates.daily_calorie_adjustment != null) setValues.dailyCalorieAdjustment = updates.daily_calorie_adjustment;
```

- [ ] **Step 4: Update the tool registry description**

In `apps/bff/src/modules/tools/tool-registry.ts`, find the `update_athlete_profile` tool entry. Add `daily_calorie_adjustment` to its `input_schema.properties` and update the description to mention it.

Read the current `update_athlete_profile` entry first to see the exact property format, then add:

```typescript
daily_calorie_adjustment: {
  type: 'number',
  description: 'Daily calorie adjustment in kcal. Negative = deficit (weight loss), positive = surplus (fuelling/gain), 0 = maintenance. Applied on top of BMR to compute the daily target.',
},
```

And update the tool description to include something like: `"Also accepts daily_calorie_adjustment to set the athlete's calorie goal mode (deficit/surplus/maintenance)."`.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter bff test tenant-isolation
```

Expected: All pass.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add apps/bff/src/modules/tools/update-athlete-profile.ts apps/bff/src/modules/tools/tool-registry.ts apps/bff/src/modules/tools/tenant-isolation.test.ts
git commit -m "feat: allow orchestrator to set daily_calorie_adjustment via update_athlete_profile"
```

---

## Task 5: Extend `get_nutrition_log` tool with calorie target and burned

**Files:**
- Modify: `apps/bff/src/modules/tools/get-nutrition-log.ts`

When Claude calls `get_nutrition_log` for a single day, it should get back `calorie_target`, `calories_burned`, and `net_calories` so it can reason about energy balance without doing arithmetic.

- [ ] **Step 1: Write a failing test**

Add to `tenant-isolation.test.ts`:

```typescript
it('getNutritionLog single-day response includes calorie_target and calories_burned', async () => {
  const { athleteId } = await seedAthlete(db);

  // Set up biometrics and activity
  await db.update(athletes)
    .set({ weightKg: 75, heightCm: 178, age: 30, sex: 'male', dailyCalorieAdjustment: 0 })
    .where(eq(athletes.id, athleteId));

  const today = new Date().toISOString().slice(0, 10);
  await db.insert(activities).values({
    id: randomUUID(),
    athleteId,
    externalId: 'tool-burned-1',
    source: 'wahoo',
    type: 'ride',
    name: 'Ride',
    startedAt: new Date(),
    durationS: 3600,
    calories: 700,
  });

  const result = await getNutritionLog({ date: today, days: 1 }, athleteId);

  expect(result.ok).toBe(true);
  expect((result as Record<string, unknown>).calorie_target).toBe(1718);
  expect((result as Record<string, unknown>).calories_burned).toBe(700);
  // net = consumed - burned; no meals logged so consumed = 0
  expect((result as Record<string, unknown>).net_calories).toBe(-700);
});
```

> Import `getNutritionLog`, `athletes`, `activities` and helpers as needed.

- [ ] **Step 2: Run to confirm it fails**

```bash
pnpm --filter bff test tenant-isolation
```

Expected: FAIL.

- [ ] **Step 3: Implement the changes**

In `apps/bff/src/modules/tools/get-nutrition-log.ts`, for the single-day path (`days === 1`):

Add imports at the top:

```typescript
import { activities, athletes } from '../../db/schema.js';
import { eq, and, gte, lte, sql as sqlFn } from 'drizzle-orm';
import { computeTarget } from '../metrics/bmr.js';
```

> Note: `sql` is already imported. Alias the new one as `sqlFn` if there's a naming conflict, or check the existing imports and use one consistently.

Before building the return value in the `days === 1` branch, add parallel queries for burned and athlete profile:

```typescript
    const todayStart = new Date(`${targetDate}T00:00:00.000Z`);
    const todayEnd = new Date(`${targetDate}T23:59:59.999Z`);

    const [burnedRows, athleteRows] = await Promise.all([
      db
        .select({ total: sql<string>`COALESCE(SUM(${activities.calories}), 0)` })
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

    const caloriesBurned = Math.round(Number(burnedRows[0]?.total ?? 0));
    const athlete = athleteRows[0];
    const calorieTarget = athlete
      ? computeTarget(
          { weightKg: athlete.weightKg, heightCm: athlete.heightCm, age: athlete.age, sex: athlete.sex },
          athlete.dailyCalorieAdjustment ?? 0,
        )
      : null;
    const netCalories = calorieTarget != null
      ? Math.round(totals.calories - caloriesBurned)
      : null;
```

Then add to the return object:

```typescript
      calorie_target: calorieTarget,
      calories_burned: caloriesBurned,
      net_calories: netCalories,
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter bff test tenant-isolation
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add apps/bff/src/modules/tools/get-nutrition-log.ts apps/bff/src/modules/tools/tenant-isolation.test.ts
git commit -m "feat: add calorie_target, calories_burned, net_calories to get_nutrition_log tool"
```

---

## Task 6: Update frontend types and NutritionTab UI

**Files:**
- Modify: `apps/web/src/lib/api-types.ts`
- Modify: `apps/web/src/components/NutritionTab.tsx`

Replace the hardcoded `CALORIE_TARGET = 2800` with the dynamic `target` from the API. Add a `Burned` stat to the four-number display: Consumed / Burned / Target / Left.

`Left = target - consumed + burned` (food consumed minus activity burned, subtracted from target).

- [ ] **Step 1: Update `NutritionToday` type**

In `apps/web/src/lib/api-types.ts`, replace the `NutritionToday` interface:

```typescript
/** GET /api/nutrition/today. All totals are null when nothing is logged. */
export interface NutritionToday {
  logged: boolean;
  calories: number | null;
  carbsG: number | null;
  proteinG: number | null;
  fatG: number | null;
  /** Total calories burned from today's activities. 0 if no activities. */
  burned: number;
  /** Computed daily calorie target (BMR + adjustment). Null if profile incomplete. */
  target: number | null;
  /** The stored daily_calorie_adjustment. 0 = maintenance, negative = deficit, positive = surplus. */
  calorieAdjustment: number;
  meals: Meal[];
}
```

- [ ] **Step 2: Rewrite NutritionTab.tsx**

Replace the full contents of `apps/web/src/components/NutritionTab.tsx`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Flame, ChevronDown } from 'lucide-react';
import { BarStat, SegmentedStats, CardIconHeader } from '@/components/shared';
import { cn } from '@/lib/utils';
import { getJson } from '@/lib/api';
import type { Meal, NutritionToday } from '@/lib/api-types';

const MACRO_TARGETS = {
  carbs:   { label: 'Carbs',   target: 350, unit: 'g', color: 'var(--color-orange)' },
  protein: { label: 'Protein', target: 140, unit: 'g', color: '#92400e' },
  fat:     { label: 'Fat',     target: 80,  unit: 'g', color: 'var(--color-lime)' },
} as const;

function mealMacros(m: Meal): string {
  const parts = [
    m.calories != null && `${m.calories} kcal`,
    m.carbsG != null && `${m.carbsG}c`,
    m.proteinG != null && `${m.proteinG}p`,
    m.fatG != null && `${m.fatG}f`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No macros logged';
}

export function NutritionTab() {
  const [today, setToday] = useState<NutritionToday | null>(null);
  const [showMeals, setShowMeals] = useState(false);

  const fetchToday = useCallback(async () => {
    const data = await getJson<NutritionToday>('/api/nutrition/today').catch(() => null);
    if (data) setToday(data);
  }, []);

  useEffect(() => {
    fetchToday();
    const t = setInterval(fetchToday, 60000);
    return () => clearInterval(t);
  }, [fetchToday]);

  const noneLogged = !today?.logged;
  const consumed = today?.calories ?? 0;
  const burned = today?.burned ?? 0;
  const target = today?.target ?? null;
  // Left = target - consumed + burned (target budget, minus what was eaten, plus what was burned)
  const left = target != null ? Math.max(0, target - consumed + burned) : null;
  const meals = today?.meals ?? [];

  const macros = [
    { ...MACRO_TARGETS.carbs,   current: today?.carbsG   ?? null },
    { ...MACRO_TARGETS.protein, current: today?.proteinG ?? null },
    { ...MACRO_TARGETS.fat,     current: today?.fatG     ?? null },
  ];

  return (
    <div className="p-5">
      <Card>
        <CardIconHeader icon={Flame} label="Nutrition" color="var(--color-primary)" iconColor="var(--color-primary-foreground)" />
        <CardContent>
          <SegmentedStats
            items={[
              {
                value: consumed,
                unit: 'kcal',
                label: 'Consumed',
                intensity: target != null ? consumed / target : 0,
                noData: noneLogged,
              },
              {
                value: burned,
                unit: 'kcal',
                label: 'Burned',
                intensity: target != null ? burned / target : 0,
                noData: burned === 0,
              },
              {
                value: target ?? 0,
                unit: 'kcal',
                label: 'Target',
                intensity: 1,
                noData: target == null,
              },
              {
                value: left ?? 0,
                unit: 'kcal',
                label: 'Left',
                intensity: target != null && left != null ? left / target : 0,
                noData: noneLogged || target == null,
              },
            ]}
          />

          <div className="flex flex-col gap-4 mt-6 pt-5 border-t border-border">
            {macros.map(m => (
              <BarStat
                key={m.label}
                value={m.current ?? 0}
                unit={m.unit}
                target={m.target}
                label={m.label}
                color={m.color}
                pct={m.current != null ? (m.current / m.target) * 100 : 0}
                noData={m.current == null}
              />
            ))}
          </div>

          {meals.length > 0 ? (
            <div className="mt-5 pt-4 border-t border-border">
              <button
                type="button"
                onClick={() => setShowMeals(v => !v)}
                className="flex items-center justify-between w-full bg-transparent border-none cursor-pointer p-0"
              >
                <span className="text-xs font-medium text-muted-foreground">
                  Today's meals ({meals.length})
                </span>
                <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform', showMeals && 'rotate-180')} />
              </button>

              {showMeals && (
                <div className="mt-3 flex flex-col">
                  {meals.map(m => (
                    <div key={m.id} className="py-2.5 border-t border-border first:border-0">
                      <p className="text-sm font-medium">{m.description}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {m.mealType && <span className="capitalize">{m.mealType} · </span>}
                        {mealMacros(m)}
                        {m.estimated && ' · estimated'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center mt-4">Log your meals via chat to track macros</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: No errors.

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api-types.ts apps/web/src/components/NutritionTab.tsx
git commit -m "feat: replace hardcoded calorie target with dynamic BMR-based target, add Burned stat to UI"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|-------------|------|
| Consumed = food calories | Already existed; unchanged |
| Burned = today's activity calories | Tasks 3, 5, 6 |
| Target = BMR ± adjustment | Tasks 1, 2, 3 |
| BMR from age/height/weight/sex (Mifflin-St Jeor) | Task 2 |
| Orchestrator can set deficit/surplus/maintenance | Task 4 |
| UI shows Consumed / Burned / Target / Left | Task 6 |
| Left = target - consumed + burned | Task 6 |
| `get_nutrition_log` tool returns energy balance | Task 5 |

All requirements covered.

**Placeholder scan:** No TBDs. All steps contain real code.

**Type consistency:**
- `computeBmr` and `computeTarget` defined in Task 2, used identically in Tasks 3 and 5.
- `dailyCalorieAdjustment` column name defined in Task 1, referenced correctly in Tasks 3, 4, 5.
- `NutritionToday.burned` / `.target` / `.calorieAdjustment` defined in Task 6 step 1, match exactly what the controller returns in Task 3.
- `left = target - consumed + burned` is consistent between the spec discussion and Task 6 implementation.

**Edge cases covered:**
- `target` is `null` when profile is incomplete (no weight/height/age) — UI shows `noData` state.
- `burned` is `0` when no activities today — not `null`, always a number.
- `dailyCalorieAdjustment` defaults to `0` in schema — maintenance by default.
