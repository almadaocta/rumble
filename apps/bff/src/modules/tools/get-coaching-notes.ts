import { z } from 'zod';
import { db } from '../../db/client.js';
import { coachingNotes } from '../../db/schema.js';
import { eq, desc, and, or, isNull, gt } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';
import { NOTE_CATEGORIES } from './vocabularies.js';

/** Most recent notes returned. Bounds the response, not the table. */
const MAX_NOTES = 20;

const GetNotesArgs = z.object({
  // Unrecognized/omitted category means "no filter" rather than a rejected
  // call — this is a read, so a category the model got slightly wrong should
  // degrade to "show everything" instead of failing the tool call outright.
  category: z.enum(NOTE_CATEGORIES).optional().catch(undefined),
});

export async function getCoachingNotes(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const { category } = GetNotesArgs.parse(args);
  const now = new Date();

  // Expiry is filtered in SQL, before the limit. Filtering in JS afterwards
  // meant the limit was spent on expired rows: an athlete with 20 notes of
  // which 15 had lapsed got 5 back, while the tool description promised "all
  // active notes". The old comment justified this by asserting a 20-row cap
  // per athlete that nothing in the schema or the write path enforces.
  const activeNotes = await db
    .select()
    .from(coachingNotes)
    .where(
      and(
        eq(coachingNotes.athleteId, athleteId),
        or(isNull(coachingNotes.expiresAt), gt(coachingNotes.expiresAt, now)),
        category ? eq(coachingNotes.category, category) : undefined,
      ),
    )
    .orderBy(desc(coachingNotes.createdAt))
    .limit(MAX_NOTES);

  return {
    ok: true,
    notes: activeNotes.map((n) => ({
      id: n.id,
      category: n.category,
      content: n.content,
      created_at: n.createdAt.toISOString(),
      expires_at: n.expiresAt?.toISOString() ?? null,
    })),
    count: activeNotes.length,
  };
}
