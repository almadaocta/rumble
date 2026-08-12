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
  // limit(2), not 1: this table is only ever supposed to hold one row, but a
  // second one has appeared before (cause unclear — not seed.ts or reset.ts,
  // both of which are exclusive/idempotent) with no error and no signal.
  // With an unordered limit(1), every request then silently and
  // nondeterministically picks one of two real athlete identities per query —
  // which is how a live conversation can end up talking to a different
  // profile than the one it started with. Fail loudly instead: single-tenant
  // mode is only safe to assume when there is, in fact, a single tenant.
  const rows = await db.select({ id: athletes.id }).from(athletes).limit(2);
  if (rows.length === 0) throw new Error('No athlete found. Run `pnpm db:seed` first.');
  if (rows.length > 1) {
    throw new Error(
      `Expected exactly one athlete row, found more than one (ids include ${rows[0].id} and ${rows[1].id}). ` +
        'Single-tenant mode assumes there is only ever one — reconcile the duplicates before continuing.',
    );
  }
  return rows[0].id;
}
