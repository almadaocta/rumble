import { z } from 'zod';
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
});

export async function saveCoachingNote(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const { content, category, expires_in_days } = SaveNoteArgs.parse(args);

  if (!content?.trim()) {
    return { ok: false, error: 'Note content is required' };
  }

  const validCategory = category;

  let expiresAt: Date | undefined;
  if (expires_in_days && expires_in_days > 0) {
    expiresAt = new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000);
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
  };
}
