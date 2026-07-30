import type { Request, Response, NextFunction } from 'express';
import { getDefaultAthleteId } from '../db/athlete.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The authenticated athlete's id for this request. Always set by resolveAthleteId. */
      athleteId: string;
    }
  }
}

/**
 * The single seam for athlete identity. Every route handler reads
 * `req.athleteId` — none of them know or care how it was resolved.
 *
 * Today there's no real auth, so every request resolves to the one seeded
 * local athlete (getDefaultAthleteId). Adding real auth later (Stytch or
 * otherwise) means replacing the body of this function with "verify the
 * session/JWT, extract the real athleteId" — every controller stays
 * untouched.
 *
 * Only resolves if req.athleteId isn't already set — this is what lets
 * integration tests inject a specific athleteId (simulating "as athlete A"
 * vs "as athlete B") via a test-only middleware mounted earlier in the
 * chain, without needing real multi-user auth to exist yet.
 */
export async function resolveAthleteId(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (req.athleteId) return next();
  try {
    req.athleteId = await getDefaultAthleteId();
    next();
  } catch (err) {
    next(err instanceof Error ? err : new Error('Failed to resolve athlete identity'));
  }
}
