// Regression test for a real production incident: a second athlete row
// existed in the dev DB alongside the real one, and getDefaultAthleteId's
// unordered `limit(1)` silently picked one or the other per query — so the
// same conversation could end up resolving to a different, incomplete
// athlete identity with no error and no signal. Single-tenant mode is only
// safe when there is, in fact, a single tenant; this pins that it now fails
// loudly instead of guessing.
import { describe, it, expect, beforeEach } from 'vitest';
import { migrateTestDb, seedAthlete } from '../test-utils/test-db.js';
import { db } from './client.js';
import { athletes } from './schema.js';
import { getDefaultAthleteId } from './athlete.js';

describe('getDefaultAthleteId', () => {
  // migrateTestDb's in-memory DB is shared across every `it` in this file
  // (and reused, not reset, between them) — this function reads the whole
  // athletes table with no per-athlete scoping, so it's the one case in this
  // suite that actually needs a clean table per test rather than just a
  // fresh row.
  beforeEach(async () => {
    migrateTestDb();
    await db.delete(athletes);
  });

  it('returns the id of the one athlete', async () => {
    const athleteId = await seedAthlete('Solo Athlete');
    await expect(getDefaultAthleteId()).resolves.toBe(athleteId);
  });

  it('throws when no athlete exists yet', async () => {
    await expect(getDefaultAthleteId()).rejects.toThrow(/no athlete found/i);
  });

  it('throws instead of silently picking one when more than one athlete exists', async () => {
    await seedAthlete('First Duplicate');
    await seedAthlete('Second Duplicate');

    await expect(getDefaultAthleteId()).rejects.toThrow(/more than one/i);
  });
});
