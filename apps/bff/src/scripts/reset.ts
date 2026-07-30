import '../env.js';
import { db } from '../db/client.js';
import {
  athletes,
  activities,
  activityLaps,
  activityStreams,
  dailyMetrics,
  nutritionLogs,
  planSessions,
  personalBests,
  powerZones,
  targetEvents,
  trainingPlans,
  wahooConnections,
  knowledgeGaps,
  coachingNotes,
  chats,
  chatMessages,
} from '../db/schema.js';
import { config } from '../config.js';

// Note: kb_chunks is left alone here, but it's now dead — specialists read the
// knowledge base straight off disk (see model-config.ts), so nothing queries
// this table. Safe to drop in a migration whenever convenient.
async function reset() {
  console.log('Resetting athlete data...\n');

  const tables = [
    { name: 'chat_messages', table: chatMessages },
    { name: 'chats', table: chats },
    { name: 'plan_sessions', table: planSessions },
    { name: 'training_plans', table: trainingPlans },
    { name: 'nutrition_logs', table: nutritionLogs },
    { name: 'daily_metrics', table: dailyMetrics },
    { name: 'activity_laps', table: activityLaps },
    { name: 'activity_streams', table: activityStreams },
    { name: 'personal_bests', table: personalBests },
    { name: 'activities', table: activities },
    { name: 'power_zones', table: powerZones },
    { name: 'target_events', table: targetEvents },
    { name: 'wahoo_connections', table: wahooConnections },
    { name: 'coaching_notes', table: coachingNotes },
    { name: 'knowledge_gaps', table: knowledgeGaps },
    { name: 'athletes', table: athletes },
  ];

  for (const { name, table } of tables) {
    await db.delete(table);
    console.log(`  ✓ ${name} — cleared`);
  }

  console.log('\nRe-seeding a blank athlete profile...');

  const [athlete] = await db
    .insert(athletes)
    .values({
      name: 'Athlete',
      timezone: config.ATHLETE_TIMEZONE,
      coachingTone: 6,
    })
    .returning();

  console.log(`  ✓ Created athlete: ${athlete.id} (clean slate — no FTP, no plan, no data)\n`);
  console.log('Done. The athlete starts from scratch — the coach will onboard via chat.');
  process.exit(0);
}

reset().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
