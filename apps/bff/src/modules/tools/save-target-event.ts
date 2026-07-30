import { z } from 'zod';
import { EVENT_ACTIONS, EVENT_TYPES, EVENT_PRIORITIES } from './vocabularies.js';
import { db } from '../../db/client.js';
import { targetEvents } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { ToolOutcome } from './tool-result.js';

const TargetEventArgs = z.object({
  action: z.enum(EVENT_ACTIONS),
  name: z.string(),
  event_date: z.string().optional(),
  event_type: z.enum(EVENT_TYPES).optional(),
  priority: z.enum(EVENT_PRIORITIES).optional(),
});

export async function saveTargetEvent(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const { action, name, event_date, event_type, priority } = TargetEventArgs.parse(args);

  if (action === 'remove') {
    const deleted = await db
      .delete(targetEvents)
      .where(and(eq(targetEvents.athleteId, athleteId), eq(targetEvents.name, name)))
      .returning();

    return {
      ok: true,
      action: 'removed',
      removed_count: deleted.length,
    };
  }

  if (!event_date) {
    return { ok: false, error: 'event_date is required when adding a target event' };
  }

  const [event] = await db
    .insert(targetEvents)
    .values({
      athleteId,
      name,
      eventDate: event_date,
      // 'other', not 'race': 'race' is not a member of the enum this tool
      // publishes, so omitting event_type persisted a value the schema says
      // cannot occur — and which no consumer filtering on the enum would match.
      eventType: event_type ?? 'other',
      priority: priority ?? 'A',
    })
    .returning();


  return {
    ok: true,
    action: 'added',
    event: { id: event.id, name: event.name, date: event.eventDate, type: event.eventType, priority: event.priority },
  };
}
