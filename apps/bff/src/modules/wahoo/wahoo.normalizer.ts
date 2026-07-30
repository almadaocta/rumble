import type { WahooWorkoutSummary } from './wahoo.client.js';
import type { ActivityType, NormalizedActivity } from '../activities/normalized-activity.js';

const BIKING_TYPES = new Set([0, 11, 12, 13, 14, 15, 16, 49, 61, 64, 68, 70]);
const GYM_TYPES = new Set([20, 22, 42, 43, 44, 66]);
const RUNNING_TYPES = new Set([1, 3, 4, 5, 67, 71]);

function mapWorkoutType(wahooTypeId: number): ActivityType {
  if (BIKING_TYPES.has(wahooTypeId)) return 'ride';
  if (GYM_TYPES.has(wahooTypeId)) return 'gym';
  if (RUNNING_TYPES.has(wahooTypeId)) return 'run';
  return 'other';
}

function nonZeroFloat(value: string | undefined | null): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return isNaN(n) || n === 0 ? null : n;
}

function nonZeroInt(value: string | undefined | null): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  return isNaN(n) || n === 0 ? null : n;
}

export interface WorkoutMeta {
  id: number;
  starts: string;
  name: string;
  workout_type_id: number;
}

export function normalizeWahooWorkout(
  summary: WahooWorkoutSummary,
  ftp?: number,
  workoutMeta?: WorkoutMeta,
): NormalizedActivity {
  // Was `summary.workout!`. The batch path passes workoutMeta because the
  // paged response carries it on the parent workout, not the summary; the
  // webhook path relies on the inline copy. When neither is there the `!`
  // produced a 'cannot read properties of undefined' several lines down,
  // naming a field rather than the missing thing.
  const meta = workoutMeta ?? summary.workout;
  if (!meta) {
    throw new Error(
      `Wahoo summary ${summary.id} has no inline workout metadata and none was supplied`,
    );
  }

  const np = nonZeroFloat(summary.power_bike_np_last);
  const tss = nonZeroFloat(summary.power_bike_tss_last);
  const durationS = Math.round(parseFloat(summary.duration_active_accum) || 0);

  let intensityFactor: number | null = null;
  if (np && ftp && ftp > 0) {
    intensityFactor = Math.round((np / ftp) * 100) / 100;
  }

  const workoutType = mapWorkoutType(meta.workout_type_id);

  return {
    externalId: String(meta.id),
    source: 'wahoo',
    type: workoutType,
    name: meta.name || `${workoutType} workout`,
    startedAt: new Date(meta.starts),
    durationS,
    distanceM: nonZeroFloat(summary.distance_accum),
    avgPower: nonZeroInt(summary.power_avg),
    normPower: np ? Math.round(np) : null,
    maxPower: nonZeroInt(summary.power_max ?? null),
    avgHr: nonZeroInt(summary.heart_rate_avg),
    maxHr: nonZeroInt(summary.heart_rate_max ?? null),
    avgCadence: nonZeroInt(summary.cadence_avg),
    elevationM: nonZeroFloat(summary.ascent_accum),
    calories: nonZeroInt(summary.calories_accum),
    tss: tss ? Math.round(tss * 10) / 10 : null,
    intensityFactor,
    fitFileUrl: summary.file?.url ?? null,
  };
}
