import '../env.js';
import { db } from '../db/client.js';
import { athletes } from '../db/schema.js';
import { config } from '../config.js';

/**
 * Bootstraps a single blank athlete row — the no-auth fallback identity
 * every request resolves to today (see middleware/auth.ts).
 *
 * Deliberately blank, not pre-filled: the /suggestions endpoint's
 * endpoint already detects an incomplete profile and prompts conversational
 * onboarding ("I'm new — what do you need to know about me?"), which calls
 * update_athlete_profile. Run this once before first `pnpm dev`, then just
 * talk to the coach to fill in FTP/weight/goals.
 */
async function seed() {
  const existing = await db.select({ id: athletes.id }).from(athletes).limit(1);
  if (existing.length > 0) {
    console.log(`Athlete already exists (${existing[0].id}) — nothing to do.`);
    process.exit(0);
  }

  console.log('Creating blank athlete profile...');

  const [athlete] = await db
    .insert(athletes)
    .values({
      name: 'Athlete',
      timezone: config.ATHLETE_TIMEZONE,
      coachingTone: 6,
    })
    .returning();

  console.log(`Created athlete: ${athlete.id}`);
  console.log('No FTP, weight, or goals set — the coach will ask on your first message.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
