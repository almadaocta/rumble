import { createHash } from 'node:crypto';
import type { ParsedFitFile } from './fit-parser.js';
import type { ActivityType, NormalizedActivity } from './normalized-activity.js';

const BIKING_SPORTS = new Set(['cycling', 'e_biking', 'handcycling']);
const RUNNING_SPORTS = new Set(['running', 'walking', 'hiking']);
const GYM_SPORTS = new Set(['training', 'fitness_equipment', 'strength_training']);

function mapFitSport(sport: string | null): ActivityType {
  if (!sport) return 'other';
  if (BIKING_SPORTS.has(sport)) return 'ride';
  if (RUNNING_SPORTS.has(sport)) return 'run';
  if (GYM_SPORTS.has(sport)) return 'gym';
  return 'other';
}

/**
 * Builds an activity record straight from a FIT file's own embedded session
 * summary, bypassing Wahoo's API entirely — for manually-uploaded/dropped
 * .fit exports from any device (Wahoo, Garmin, etc).
 */
export function normalizeFitImport(
  fileBytes: Uint8Array,
  parsed: ParsedFitFile,
  fallbackName: string,
  ftp?: number,
): NormalizedActivity | null {
  const session = parsed.session;
  if (!session) return null;

  const np = session.normPower;
  let tss: number | null = null;
  let intensityFactor: number | null = null;
  if (np && ftp && ftp > 0 && session.durationS > 0) {
    intensityFactor = Math.round((np / ftp) * 100) / 100;
    tss = Math.round(((session.durationS * np * np) / (ftp * ftp * 3600)) * 100 * 10) / 10;
  }

  // Deterministic id from the file's own bytes so re-uploading the same
  // export is a no-op update rather than a duplicate activity.
  const externalId = createHash('sha256').update(fileBytes).digest('hex').slice(0, 32);

  return {
    externalId,
    source: 'manual',
    type: mapFitSport(session.sport),
    name: fallbackName,
    startedAt: session.startedAt,
    durationS: session.durationS,
    distanceM: session.distanceM,
    avgPower: session.avgPower,
    normPower: session.normPower,
    maxPower: session.maxPower,
    avgHr: session.avgHr,
    maxHr: session.maxHr,
    avgCadence: session.avgCadence,
    elevationM: session.elevationGain,
    calories: session.calories,
    tss,
    intensityFactor,
    fitFileUrl: null,
  };
}
