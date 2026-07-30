import '../env.js';
import { db } from '../db/client.js';
import { athletes } from '../db/schema.js';
import { recomputeAllBests } from '../modules/metrics/power-bests.js';

async function backfill() {
  const allAthletes = await db.select({ id: athletes.id }).from(athletes);

  for (const athlete of allAthletes) {
    await recomputeAllBests(athlete.id);
  }

  console.log('\nBackfill complete.');
  process.exit(0);
}

backfill().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
