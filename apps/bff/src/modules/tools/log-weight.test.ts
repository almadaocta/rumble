import { describe, it, expect, beforeAll } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { weightLogs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logWeight } from './log-weight.js';

describe('logWeight', () => {
  let athleteId: string;
  let otherAthleteId: string;

  beforeAll(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Test Athlete');
    otherAthleteId = await seedAthlete('Other Athlete');
  });

  it('inserts a weight log and returns the row', async () => {
    const result = await logWeight({ weight_kg: 74.5 }, athleteId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.weight_kg).toBe(74.5);
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.id).toBeTruthy();
  });

  it('accepts an explicit date', async () => {
    const result = await logWeight({ weight_kg: 73.0, date: '2026-01-15' }, athleteId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.date).toBe('2026-01-15');
  });

  it('upserts on same date — replaces weight rather than duplicating', async () => {
    const date = '2026-02-01';
    await logWeight({ weight_kg: 75.0, date }, athleteId);
    const second = await logWeight({ weight_kg: 74.2, date }, athleteId);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.weight_kg).toBe(74.2);

    const rows = await db
      .select()
      .from(weightLogs)
      .where(eq(weightLogs.athleteId, athleteId));
    const dateRows = rows.filter((r) => r.date === date);
    expect(dateRows).toHaveLength(1);
    expect(dateRows[0].weightKg).toBe(74.2);
  });

  it('stores an optional note', async () => {
    const result = await logWeight(
      { weight_kg: 73.8, date: '2026-03-01', note: 'post-race' },
      athleteId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note).toBe('post-race');
  });

  it('is scoped by athleteId — other athlete logs do not appear', async () => {
    await logWeight({ weight_kg: 90.0, date: '2026-04-01' }, otherAthleteId);

    const rows = await db
      .select()
      .from(weightLogs)
      .where(eq(weightLogs.athleteId, athleteId));
    const leaked = rows.find((r) => r.weightKg === 90.0);
    expect(leaked).toBeUndefined();
  });

  it('throws ZodError on missing weight_kg', async () => {
    await expect(logWeight({}, athleteId)).rejects.toThrow();
  });

  it('throws ZodError on non-positive weight', async () => {
    await expect(logWeight({ weight_kg: -1 }, athleteId)).rejects.toThrow();
  });
});
