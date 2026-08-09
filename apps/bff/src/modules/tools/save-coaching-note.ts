import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { NOTE_CATEGORIES } from './vocabularies.js';
import { db } from '../../db/client.js';
import { coachingNotes } from '../../db/schema.js';
import type { ToolOutcome } from './tool-result.js';

const SaveNoteArgs = z.object({
  content: z.string().optional(),
  // An unrecognized category falls back to 'general' rather than rejecting
  // the whole note — the category is a nice-to-have grouping, not essential.
  category: z.enum(NOTE_CATEGORIES).catch('general'),
  expires_in_days: z.number().optional(),
  supersedes_note_id: z.string().optional(),
});

export async function saveCoachingNote(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const { content, category, expires_in_days, supersedes_note_id } = SaveNoteArgs.parse(args);

  if (!content?.trim()) {
    return { ok: false, error: 'Note content is required' };
  }

  const validCategory = category;

  let expiresAt: Date | undefined;
  if (expires_in_days && expires_in_days > 0) {
    expiresAt = new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000);
  }

  // Retire the note this one replaces rather than leaving both live — without
  // this, a revised decision (e.g. a pacing plan course-correction) sits
  // alongside the plan it replaced forever, doubling the archive for that
  // category every time a decision changes. Scoped to this athlete so a
  // guessed/stale id from another athlete can't expire someone else's note.
  if (supersedes_note_id) {
    await db
      .update(coachingNotes)
      .set({ expiresAt: new Date() })
      .where(and(eq(coachingNotes.id, supersedes_note_id), eq(coachingNotes.athleteId, athleteId)));
  }

  const [note] = await db
    .insert(coachingNotes)
    .values({
      athleteId,
      category: validCategory,
      content: content.trim(),
      expiresAt,
    })
    .returning();


  return {
    ok: true,
    note_id: note.id,
    category: validCategory,
    expires_at: expiresAt?.toISOString() ?? null,
    superseded_note_id: supersedes_note_id ?? null,
  };
}
