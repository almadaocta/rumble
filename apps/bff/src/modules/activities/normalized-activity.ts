/**
 * The shape every activity takes once it has crossed a source boundary.
 *
 * This lived in `modules/wahoo/wahoo.normalizer.ts`, which made the whole
 * activities module depend on the Wahoo adapter for a type that has nothing to
 * do with Wahoo — the manual .fit upload path produces one too, and index.ts
 * documents that path as working without any Wahoo setup at all. Owning it here
 * lets each source adapter depend on activities/ rather than the reverse.
 */
/**
 * The closed vocabulary every source adapter maps its own sport codes onto.
 *
 * Both normalizers already returned exactly these four and nothing else, but
 * said `string`, so the agreement was a convention rather than a rule: a typo
 * in one mapper produced an activity type nothing else in the app matches, and
 * get_training_data's `type` filter accepted any string and quietly returned an
 * empty list for the ones that can't exist.
 *
 * Exported as a const tuple so zod schemas and JSON Schema enums can be built
 * from the same list rather than restating it.
 */
export const ACTIVITY_TYPES = ['ride', 'run', 'gym', 'other'] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface NormalizedActivity {
  externalId: string;
  source: string;
  type: ActivityType;
  name: string;
  startedAt: Date;
  durationS: number;
  distanceM: number | null;
  avgPower: number | null;
  normPower: number | null;
  maxPower: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  elevationM: number | null;
  calories: number | null;
  tss: number | null;
  intensityFactor: number | null;
  fitFileUrl: string | null;
}
