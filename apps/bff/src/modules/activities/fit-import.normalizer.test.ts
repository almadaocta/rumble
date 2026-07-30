/**
 * The manual-upload boundary: a parsed .fit file becomes a NormalizedActivity.
 *
 * The counterpart to wahoo.normalizer.ts, and the reason .fit import works with
 * no Wahoo setup at all. Two properties carry real weight here — the
 * deterministic external id, which is what makes re-uploading the same export an
 * update rather than a duplicate ride, and the TSS derivation, which is the only
 * place this path computes training load rather than being handed it.
 */
import { describe, it, expect } from 'vitest';
import { normalizeFitImport } from './fit-import.normalizer.js';
import type { ParsedFitFile, ParsedSession } from './fit-parser.js';

const STARTED = new Date('2026-05-04T07:15:00Z');

function session(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sport: 'cycling',
    subSport: null,
    startedAt: STARTED,
    durationS: 3600,
    distanceM: 32000,
    avgPower: 210,
    maxPower: 620,
    normPower: 225,
    avgHr: 148,
    maxHr: 176,
    avgCadence: 88,
    elevationGain: 420,
    calories: 750,
    ...overrides,
  };
}

function parsed(overrides: Partial<ParsedSession> | null = {}): ParsedFitFile {
  return {
    session: overrides === null ? null : session(overrides),
    laps: [],
    // The normalizer reads only `session`; the streams are along for the ride.
    streams: {
      timestamps: [], power: [], heartRate: [], cadence: [], speed: [],
      altitude: [], distance: [], temperature: [], lat: [], lng: [], sampleCount: 0,
    },
  };
}

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

describe('normalizeFitImport', () => {
  it('maps a parsed session onto the stored shape', () => {
    const a = normalizeFitImport(BYTES, parsed(), 'Morning ride', 250);

    expect(a).not.toBeNull();
    expect(a).toMatchObject({
      source: 'manual',
      type: 'ride',
      name: 'Morning ride',
      startedAt: STARTED,
      durationS: 3600,
      distanceM: 32000,
      avgPower: 210,
      normPower: 225,
      maxPower: 620,
      avgHr: 148,
      maxHr: 176,
      avgCadence: 88,
      elevationM: 420,
      calories: 750,
      // Nothing to download: the file is already in hand.
      fitFileUrl: null,
    });
  });

  it('returns null when the file has no session summary', () => {
    expect(normalizeFitImport(BYTES, parsed(null), 'Whatever')).toBeNull();
  });

  it('derives the external id from the file bytes, not the metadata', () => {
    // Re-uploading the same export must be an update, not a second ride — the id
    // is the upsert key, so it has to be stable across name and FTP changes.
    const a = normalizeFitImport(BYTES, parsed(), 'First name', 250);
    const b = normalizeFitImport(BYTES, parsed(), 'Different name', 300);

    expect(a!.externalId).toBe(b!.externalId);
    expect(a!.externalId).toHaveLength(32);
  });

  it('gives a different id to a different file', () => {
    const a = normalizeFitImport(BYTES, parsed(), 'Ride');
    const b = normalizeFitImport(new Uint8Array([9, 9, 9]), parsed(), 'Ride');

    expect(a!.externalId).not.toBe(b!.externalId);
  });

  describe('sport mapping', () => {
    const cases: Array<[string | null, string]> = [
      ['cycling', 'ride'],
      ['e_biking', 'ride'],
      ['handcycling', 'ride'],
      ['running', 'run'],
      ['walking', 'run'],
      ['hiking', 'run'],
      ['training', 'gym'],
      ['fitness_equipment', 'gym'],
      ['strength_training', 'gym'],
      ['swimming', 'other'],
      [null, 'other'],
    ];

    for (const [sport, expected] of cases) {
      it(`maps ${sport ?? 'a missing sport'} to ${expected}`, () => {
        expect(normalizeFitImport(BYTES, parsed({ sport }), 'x')!.type).toBe(expected);
      });
    }
  });

  describe('training load', () => {
    it('computes IF and TSS from normalized power and FTP', () => {
      const a = normalizeFitImport(BYTES, parsed({ normPower: 225, durationS: 3600 }), 'x', 250)!;

      // IF = 225/250 = 0.9; TSS = (3600 * 225^2) / (250^2 * 3600) * 100 = 81.
      expect(a.intensityFactor).toBe(0.9);
      expect(a.tss).toBe(81);
    });

    it('scores an hour exactly at FTP as 100 TSS', () => {
      // The definition of TSS, and the check that the formula is the right way up.
      const a = normalizeFitImport(BYTES, parsed({ normPower: 250, durationS: 3600 }), 'x', 250)!;

      expect(a.tss).toBe(100);
      expect(a.intensityFactor).toBe(1);
    });

    it('leaves both null when FTP is unknown', () => {
      const a = normalizeFitImport(BYTES, parsed(), 'x')!;

      expect(a.tss).toBeNull();
      expect(a.intensityFactor).toBeNull();
    });

    it('leaves both null when the ride has no power data', () => {
      const a = normalizeFitImport(BYTES, parsed({ normPower: null }), 'x', 250)!;

      expect(a.tss).toBeNull();
      expect(a.intensityFactor).toBeNull();
    });

    it('does not divide by zero on a zero-duration or zero-FTP session', () => {
      expect(normalizeFitImport(BYTES, parsed({ durationS: 0 }), 'x', 250)!.tss).toBeNull();
      expect(normalizeFitImport(BYTES, parsed(), 'x', 0)!.tss).toBeNull();
    });
  });

  it('passes missing optional measurements through as null', () => {
    // A ride from a computer with no power meter, HR strap or barometer.
    const a = normalizeFitImport(
      BYTES,
      parsed({
        avgPower: null,
        maxPower: null,
        normPower: null,
        avgHr: null,
        maxHr: null,
        avgCadence: null,
        elevationGain: null,
        calories: null,
        distanceM: null,
      }),
      'Trainer session',
      250,
    )!;

    expect(a).toMatchObject({
      avgPower: null,
      normPower: null,
      avgHr: null,
      elevationM: null,
      distanceM: null,
      tss: null,
    });
    // Still a usable activity: the duration and the clock are what it needs.
    expect(a.durationS).toBe(3600);
    expect(a.startedAt).toBe(STARTED);
  });
});
