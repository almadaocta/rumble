/**
 * Tests for the Wahoo → NormalizedActivity boundary.
 *
 * This is the only translation point between the vendor's all-strings payload
 * and the shape the rest of the app stores, so its conversion and null rules
 * decide what every downstream consumer sees. Previously untested.
 */
import { describe, it, expect } from 'vitest';
import { normalizeWahooWorkout } from './wahoo.normalizer.js';
import { WahooWorkoutSummarySchema, type WahooWorkoutSummary } from './wahoo.client.js';

function summary(overrides: Partial<WahooWorkoutSummary> = {}): WahooWorkoutSummary {
  return {
    id: 1,
    ascent_accum: '420.5',
    cadence_avg: '88',
    calories_accum: '750',
    distance_accum: '32000.4',
    duration_active_accum: '3612.7',
    duration_paused_accum: '0',
    duration_total_accum: '3700',
    heart_rate_avg: '148',
    heart_rate_max: '176',
    power_bike_np_last: '228.4',
    power_bike_tss_last: '86.44',
    power_avg: '210',
    power_max: '612',
    speed_avg: '8.9',
    work_accum: '760',
    file: { url: 'https://example.invalid/f.fit' },
    workout: {
      id: 99,
      starts: '2026-03-01T08:00:00Z',
      minutes: 60,
      name: 'Threshold intervals',
      workout_type_id: 0,
      plan_id: null,
    },
    ...overrides,
  };
}

describe('normalizeWahooWorkout', () => {
  it('maps the vendor payload onto the stored shape', () => {
    const a = normalizeWahooWorkout(summary());

    expect(a.externalId).toBe('99');
    expect(a.source).toBe('wahoo');
    expect(a.name).toBe('Threshold intervals');
    expect(a.startedAt).toEqual(new Date('2026-03-01T08:00:00Z'));
    expect(a.fitFileUrl).toBe('https://example.invalid/f.fit');
  });

  it('rounds active duration to whole seconds', () => {
    expect(normalizeWahooWorkout(summary()).durationS).toBe(3613);
  });

  it('classifies workout types, falling back to "other"', () => {
    expect(normalizeWahooWorkout(summary({ workout: { ...summary().workout!, workout_type_id: 0 } })).type).toBe('ride');
    expect(normalizeWahooWorkout(summary({ workout: { ...summary().workout!, workout_type_id: 42 } })).type).toBe('gym');
    expect(normalizeWahooWorkout(summary({ workout: { ...summary().workout!, workout_type_id: 1 } })).type).toBe('run');
    expect(normalizeWahooWorkout(summary({ workout: { ...summary().workout!, workout_type_id: 9999 } })).type).toBe('other');
  });

  it('names the activity by type when the vendor sends an empty name', () => {
    const a = normalizeWahooWorkout(summary({ workout: { ...summary().workout!, name: '' } }));
    expect(a.name).toBe('ride workout');
  });

  it('derives intensity factor from normalized power and FTP, to 2dp', () => {
    // NP 228.4 / FTP 250 = 0.9136 -> 0.91
    expect(normalizeWahooWorkout(summary(), 250).intensityFactor).toBe(0.91);
  });

  it('leaves intensity factor null without an FTP, rather than guessing', () => {
    expect(normalizeWahooWorkout(summary()).intensityFactor).toBeNull();
    expect(normalizeWahooWorkout(summary(), 0).intensityFactor).toBeNull();
  });

  it('rounds TSS to 1dp and normalized power to a whole watt', () => {
    const a = normalizeWahooWorkout(summary());
    expect(a.tss).toBe(86.4);
    expect(a.normPower).toBe(228);
  });

  it('prefers explicit workout metadata over the embedded workout', () => {
    const a = normalizeWahooWorkout(summary(), undefined, {
      id: 555,
      starts: '2026-04-02T06:30:00Z',
      name: 'Recovery spin',
      workout_type_id: 0,
    });
    expect(a.externalId).toBe('555');
    expect(a.name).toBe('Recovery spin');
  });

  it('maps absent optional fields to null', () => {
    const s = summary();
    delete s.power_max;
    delete s.heart_rate_max;
    s.file = { url: null };

    const a = normalizeWahooWorkout(s);
    expect(a.maxPower).toBeNull();
    expect(a.maxHr).toBeNull();
    expect(a.fitFileUrl).toBeNull();
  });

  // Documents a real semantic quirk rather than endorsing it: nonZeroFloat/nonZeroInt
  // treat 0 as missing, so a genuinely flat ride records null elevation rather
  // than 0. Downstream code must not read null here as "no data recorded".
  it('collapses a legitimate zero to null', () => {
    const a = normalizeWahooWorkout(summary({ ascent_accum: '0', power_avg: '0' }));
    expect(a.elevationM).toBeNull();
    expect(a.avgPower).toBeNull();
  });

  it('treats unparseable numerics as null instead of NaN', () => {
    const a = normalizeWahooWorkout(summary({ distance_accum: 'n/a', cadence_avg: '' }));
    expect(a.distanceM).toBeNull();
    expect(a.avgCadence).toBeNull();
  });
});

/**
 * The webhook body used to be asserted straight into the normalizer with
 * `as any`. Wahoo omits the measurements a workout has no data for, so the
 * interface's "everything is a required string" claim was false even for real
 * payloads — and for an unexpected one, the normalizer happily built an
 * activity out of undefined fields.
 */
describe('WahooWorkoutSummarySchema', () => {
  it('accepts a payload with only the fields a workout actually recorded', () => {
    // A ride from a head unit with no power meter and no HR strap.
    const parsed = WahooWorkoutSummarySchema.safeParse({
      id: 7,
      duration_active_accum: '3600',
      distance_accum: '28000',
      workout: { id: 7, starts: '2026-03-01T08:00:00Z', workout_type_id: 0 },
    });

    expect(parsed.success).toBe(true);
  });

  it('keeps fields Wahoo adds that we do not model', () => {
    const parsed = WahooWorkoutSummarySchema.parse({
      id: 7,
      duration_active_accum: '3600',
      some_new_metric: '12.5',
    });

    expect(parsed).toHaveProperty('some_new_metric', '12.5');
  });

  it('rejects a body with no duration', () => {
    // duration_active_accum is parsed directly rather than through the nonZero*
    // helpers, and an activity with no duration is not an activity.
    expect(WahooWorkoutSummarySchema.safeParse({ id: 7 }).success).toBe(false);
  });

  it('rejects a body that is not a workout summary at all', () => {
    expect(WahooWorkoutSummarySchema.safeParse({ hello: 'world' }).success).toBe(false);
    expect(WahooWorkoutSummarySchema.safeParse(null).success).toBe(false);
  });

  it('rejects a numeric field sent as a number rather than a string', () => {
    // Worth pinning: the conversion helpers all take strings, so a real number
    // here would silently become null rather than the value Wahoo sent.
    const parsed = WahooWorkoutSummarySchema.safeParse({
      id: 7,
      duration_active_accum: '3600',
      power_avg: 210,
    });

    expect(parsed.success).toBe(false);
  });
});

describe('normalizeWahooWorkout metadata', () => {
  it('throws naming the summary when neither inline nor supplied metadata exists', () => {
    const noMeta = { ...summary(), workout: undefined };

    expect(() => normalizeWahooWorkout(noMeta)).toThrow(/summary 1 has no inline workout metadata/);
  });

  it('prefers supplied metadata over the inline copy', () => {
    const a = normalizeWahooWorkout(summary(), undefined, {
      id: 500,
      starts: '2026-04-02T06:30:00Z',
      name: 'From the paged response',
      workout_type_id: 0,
    });

    expect(a.externalId).toBe('500');
    expect(a.name).toBe('From the paged response');
  });
});
