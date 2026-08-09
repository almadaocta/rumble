import { describe, it, expect, beforeEach } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { coachingNotes } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { saveCoachingNote } from './save-coaching-note.js';

interface SaveResult {
  ok: boolean;
  note_id?: string;
  category?: string;
  superseded_note_id?: string | null;
}

describe('saveCoachingNote', () => {
  let athleteId: string;

  beforeEach(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Notes Athlete');
  });

  it('rejects an empty note', async () => {
    const result = (await saveCoachingNote({ content: '   ' }, athleteId)) as SaveResult;
    expect(result.ok).toBe(false);
  });

  it('falls back to general on an unrecognized category', async () => {
    const result = (await saveCoachingNote(
      { content: 'Something worth remembering', category: 'not-a-real-category' },
      athleteId,
    )) as SaveResult;
    expect(result.category).toBe('general');
  });

  /**
   * Without supersedes_note_id, a revised decision (course-corrected pacing
   * plan, updated macro target) just piles up next to the one it replaced —
   * this is what keeps a category's archive bounded as the athlete's plan
   * evolves over a season instead of growing every time it changes.
   */
  it('expires the superseded note instead of leaving both active', async () => {
    const original = (await saveCoachingNote(
      { content: 'Pacing plan v1: 220W NP ceiling', category: 'decision' },
      athleteId,
    )) as SaveResult;

    const revised = (await saveCoachingNote(
      {
        content: 'Pacing plan v2 (course correction): 205W NP ceiling',
        category: 'decision',
        supersedes_note_id: original.note_id,
      },
      athleteId,
    )) as SaveResult;

    expect(revised.superseded_note_id).toBe(original.note_id);

    const [oldNote] = await db
      .select()
      .from(coachingNotes)
      .where(eq(coachingNotes.id, original.note_id!));
    expect(oldNote.expiresAt).not.toBeNull();
    expect(oldNote.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('does not let supersedes_note_id expire another athlete’s note', async () => {
    const other = await seedAthlete('Other Athlete');
    const theirs = (await saveCoachingNote(
      { content: "Other athlete's decision", category: 'decision' },
      other,
    )) as SaveResult;

    await saveCoachingNote(
      { content: 'My note', category: 'decision', supersedes_note_id: theirs.note_id },
      athleteId,
    );

    const [untouched] = await db
      .select()
      .from(coachingNotes)
      .where(eq(coachingNotes.id, theirs.note_id!));
    expect(untouched.expiresAt).toBeNull();
  });
});
