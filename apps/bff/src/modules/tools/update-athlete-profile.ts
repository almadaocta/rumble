import { z } from 'zod';
import { SEXES, EXPERIENCE_LEVELS, PRIMARY_GOALS } from './vocabularies.js';
import { db } from '../../db/client.js';
import { athletes } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';

const ProfileUpdate = z.object({
  weight_kg: z.number().optional(),
  height_cm: z.number().optional(),
  age: z.number().optional(),
  sex: z.enum(SEXES).optional(),
  available_hours_week: z.number().optional(),
  experience_level: z.enum(EXPERIENCE_LEVELS).optional(),
  primary_goal: z.enum(PRIMARY_GOALS).optional(),
  coaching_tone: z.number().optional(),
});

export async function updateAthleteProfile(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const updates = ProfileUpdate.parse(args);

  const setValues: Record<string, unknown> = {};

  if (updates.weight_kg != null) setValues.weightKg = updates.weight_kg;
  if (updates.height_cm != null) setValues.heightCm = updates.height_cm;
  if (updates.age != null) setValues.age = updates.age;
  if (updates.sex != null) setValues.sex = updates.sex;
  if (updates.available_hours_week != null) setValues.availableHoursWeek = updates.available_hours_week;
  if (updates.experience_level != null) setValues.experienceLevel = updates.experience_level;
  if (updates.primary_goal != null) setValues.primaryGoal = updates.primary_goal;
  if (updates.coaching_tone != null) setValues.coachingTone = updates.coaching_tone;

  if (Object.keys(setValues).length === 0) {
    return { ok: false, error: 'No valid fields provided to update' };
  }

  await db.update(athletes).set(setValues).where(eq(athletes.id, athleteId));

  const updatedFields = Object.entries(updates)
    .filter(([, v]) => v != null)
    .map(([k]) => k);

  return {
    ok: true,
    updated_fields: updatedFields,
    message: `Profile updated: ${updatedFields.join(', ')}`,
  };
}
