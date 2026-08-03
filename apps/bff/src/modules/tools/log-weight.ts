import { z } from 'zod';
import { db } from '../../db/client.js';
import { weightLogs } from '../../db/schema.js';
import { sql } from 'drizzle-orm';
import type { ToolFailure } from './tool-result.js';
import { utcDateString } from '../../lib/format.js';
import { randomUUID } from 'node:crypto';

const LogWeightArgs = z.object({
  weight_kg: z.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().optional(),
});

export type LogWeightSuccess = {
  ok: true;
  id: string;
  date: string;
  weight_kg: number;
  note?: string;
};

/**
 * Upserts a daily weigh-in for the athlete.
 *
 * One row per athlete per date — a second log for the same day replaces the
 * first rather than creating a duplicate. This matches real-world behaviour
 * (athlete weighs themselves, realises they forgot to subtract clothes weight,
 * logs again). The unique index on (athlete_id, date) enforces the constraint
 * at the DB level; the DO UPDATE is the application-level behaviour on conflict.
 */
export async function logWeight(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<LogWeightSuccess | ToolFailure> {
  const { weight_kg, date, note } = LogWeightArgs.parse(args);

  const logDate = date ?? utcDateString();

  const [row] = await db
    .insert(weightLogs)
    .values({
      id: randomUUID(),
      athleteId,
      date: logDate,
      weightKg: weight_kg,
      note,
      source: 'chat',
    })
    .onConflictDoUpdate({
      target: [weightLogs.athleteId, weightLogs.date],
      set: {
        weightKg: weight_kg,
        note: note ?? sql`note`,
        source: 'chat',
      },
    })
    .returning();

  return {
    ok: true,
    id: row.id,
    date: row.date,
    weight_kg: row.weightKg,
    note: row.note ?? undefined,
  };
}
