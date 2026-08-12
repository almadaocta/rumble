// One-time cleanup: getDefaultAthleteId() had no ORDER BY, so with two
// athlete rows in the DB (how the second one got created is unclear — not
// seed.ts or reset.ts, both of which are idempotent/exclusive), requests
// nondeterministically resolved to whichever one SQLite's query plan
// returned first. Deletes one athlete and everything under it, in the same
// dependency order as reset.ts (tables without an onDelete: 'cascade' FK
// have to be cleared explicitly; the ones with cascade — plan_sessions off
// training_plans, activity_laps/streams off activities, chat_messages off
// chats, weight_logs off athletes itself — are left for the cascade).
//
// Usage: tsx src/scripts/delete-athlete.ts <athlete-id>
import '../env.js';
import { db } from '../db/client.js';
import {
  athletes,
  activities,
  dailyMetrics,
  nutritionLogs,
  personalBests,
  powerZones,
  targetEvents,
  trainingPlans,
  wahooConnections,
  coachingNotes,
  chats,
} from '../db/schema.js';
import { eq } from 'drizzle-orm';

async function main() {
  const athleteId = process.argv[2];
  if (!athleteId) {
    console.error('Usage: tsx src/scripts/delete-athlete.ts <athlete-id>');
    process.exit(1);
  }

  const [athlete] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athlete) {
    console.error(`No athlete found with id ${athleteId}`);
    process.exit(1);
  }

  console.log(`Deleting athlete ${athlete.id} (${athlete.name}, FTP ${athlete.ftp ?? 'unset'})...\n`);

  const tables = [
    { name: 'chats', table: chats },
    { name: 'training_plans', table: trainingPlans },
    { name: 'nutrition_logs', table: nutritionLogs },
    { name: 'daily_metrics', table: dailyMetrics },
    { name: 'activities', table: activities },
    { name: 'personal_bests', table: personalBests },
    { name: 'power_zones', table: powerZones },
    { name: 'target_events', table: targetEvents },
    { name: 'wahoo_connections', table: wahooConnections },
    { name: 'coaching_notes', table: coachingNotes },
    // knowledge_gaps is deliberately absent: it's global (specialist/topic/
    // query), not athlete-scoped — it has no athleteId column at all.
  ] as const;

  for (const { name, table } of tables) {
    const deleted = await db.delete(table).where(eq(table.athleteId, athleteId)).returning();
    console.log(`  - ${name}: ${deleted.length} row(s) removed`);
  }

  await db.delete(athletes).where(eq(athletes.id, athleteId));
  console.log(`  - athletes: 1 row removed\n`);

  const remaining = await db.select({ id: athletes.id, name: athletes.name }).from(athletes);
  console.log('Remaining athletes:', remaining);
  process.exit(0);
}

main().catch((err) => {
  console.error('Delete failed:', err);
  process.exit(1);
});
