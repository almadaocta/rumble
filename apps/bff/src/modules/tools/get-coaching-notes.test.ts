/**
 * get_coaching_notes promises the coach "all active notes".
 *
 * It used to apply its 20-row limit *before* filtering expired ones in JS, so
 * an athlete with 20 notes of which 15 had lapsed got 5 back while the tool
 * description still claimed completeness — the coach would plan around notes it
 * had silently never seen. The old comment justified this with a 20-row-per-
 * athlete cap that nothing in the schema or the write path enforces.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { coachingNotes } from '../../db/schema.js';
import { getCoachingNotes } from './get-coaching-notes.js';

interface NotesResult {
  ok: boolean;
  notes?: Array<{ content: string; category: string; expires_at: string | null }>;
  count?: number;
}

const HOUR = 60 * 60 * 1000;

async function addNote(
  athleteId: string,
  content: string,
  expiresAt: Date | null,
  category = 'general',
) {
  await db.insert(coachingNotes).values({
    athleteId,
    category,
    content,
    expiresAt: expiresAt ?? undefined,
  });
}

describe('getCoachingNotes', () => {
  let athleteId: string;

  beforeEach(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Notes Athlete');
  });

  it('returns notes with no expiry', async () => {
    await addNote(athleteId, 'Prefers morning rides', null);

    const result = (await getCoachingNotes({}, athleteId)) as NotesResult;
    expect(result.ok).toBe(true);
    expect(result.notes?.map((n) => n.content)).toContain('Prefers morning rides');
  });

  it('excludes an expired note', async () => {
    await addNote(athleteId, 'Knee niggle — watch load', new Date(Date.now() - HOUR));

    const result = (await getCoachingNotes({}, athleteId)) as NotesResult;
    expect(result.notes).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  it('includes a note that has not expired yet', async () => {
    await addNote(athleteId, 'Travelling this week', new Date(Date.now() + HOUR));

    const result = (await getCoachingNotes({}, athleteId)) as NotesResult;
    expect(result.notes?.map((n) => n.content)).toContain('Travelling this week');
  });

  it('does not let expired notes consume the row limit', async () => {
    // 25 expired then 6 active. Filtering after a 20-row limit would return
    // zero active notes; filtering in SQL returns all six.
    for (let i = 0; i < 25; i++) {
      await addNote(athleteId, `expired ${i}`, new Date(Date.now() - HOUR));
    }
    for (let i = 0; i < 6; i++) {
      await addNote(athleteId, `active ${i}`, null);
    }

    const result = (await getCoachingNotes({}, athleteId)) as NotesResult;
    expect(result.count).toBe(6);
    expect(result.notes?.every((n) => n.content.startsWith('active'))).toBe(true);
  });

  it('caps the response at 20 notes', async () => {
    for (let i = 0; i < 30; i++) {
      await addNote(athleteId, `note ${i}`, null);
    }

    const result = (await getCoachingNotes({}, athleteId)) as NotesResult;
    expect(result.count).toBe(20);
  });

  it('returns only the requesting athlete’s notes', async () => {
    const other = await seedAthlete('Other Athlete');
    await addNote(other, "Other athlete's note", null);
    await addNote(athleteId, 'My note', null);

    const result = (await getCoachingNotes({}, athleteId)) as NotesResult;
    expect(result.notes?.map((n) => n.content)).toEqual(['My note']);
  });

  it('filters by category when given one', async () => {
    await addNote(athleteId, 'Pacing plan for Girona', null, 'decision');
    await addNote(athleteId, 'Macro targets', null, 'nutrition');

    const result = (await getCoachingNotes({ category: 'decision' }, athleteId)) as NotesResult;
    expect(result.notes?.map((n) => n.content)).toEqual(['Pacing plan for Girona']);
  });

  it('returns all active notes when category is omitted', async () => {
    await addNote(athleteId, 'Pacing plan for Girona', null, 'decision');
    await addNote(athleteId, 'Macro targets', null, 'nutrition');

    const result = (await getCoachingNotes({}, athleteId)) as NotesResult;
    expect(result.count).toBe(2);
  });

  it('falls back to unfiltered on an unrecognized category rather than rejecting the call', async () => {
    await addNote(athleteId, 'Pacing plan for Girona', null, 'decision');

    const result = (await getCoachingNotes({ category: 'not-a-real-category' }, athleteId)) as NotesResult;
    expect(result.ok).toBe(true);
  });
});
