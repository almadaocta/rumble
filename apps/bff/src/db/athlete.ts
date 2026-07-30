import { db } from './client.js';
import { athletes } from './schema.js';

/**
 * No-auth fallback: the one seeded local athlete. This is the ONLY place in
 * the app that assumes single-tenancy — every route handler gets its
 * athleteId from `req.athleteId` (see middleware/auth.ts), which calls this
 * only because there's no real identity provider wired up yet. Swapping in
 * real auth (Stytch or otherwise) later means changing resolveAthleteId in
 * middleware/auth.ts to derive athleteId from a session/JWT instead of
 * calling this — no other call site needs to change.
 */
export async function getDefaultAthleteId(): Promise<string> {
  const [athlete] = await db.select({ id: athletes.id }).from(athletes).limit(1);
  if (!athlete) throw new Error('No athlete found. Run `pnpm db:seed` first.');
  return athlete.id;
}
