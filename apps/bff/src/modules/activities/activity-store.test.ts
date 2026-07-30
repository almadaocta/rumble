/**
 * Regression tests for the shared activity-persistence step.
 *
 * This code used to exist twice — in `wahoo.sync.ts` and inline in the
 * `/import-fit` controller — and the copies had drifted on how they treated
 * missing numeric fields. The Wahoo path coalesced to null; the upload path
 * passed values straight through. These tests pin the column semantics so the
 * two ingest paths can't diverge again.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { activities, activityLaps, activityStreams } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { upsertActivity, storeFitDetails } from './activity-store.js';
import { persistActivity } from './activity-ingest.js';
import { buildDetailedContext } from '../athlete/context-preamble.js';
import type { NormalizedActivity } from './normalized-activity.js';

function buildNormalized(overrides: Partial<NormalizedActivity> = {}): NormalizedActivity {
  return {
    externalId: 'ext-1',
    source: 'wahoo',
    type: 'ride',
    name: 'Threshold intervals',
    startedAt: new Date('2026-03-01T08:00:00Z'),
    durationS: 3600,
    distanceM: 30000,
    avgPower: 210,
    normPower: 225,
    maxPower: 600,
    avgHr: 150,
    maxHr: 178,
    avgCadence: 88,
    elevationM: 400,
    calories: 750,
    tss: 85,
    intensityFactor: 0.85,
    fitFileUrl: null,
    ...overrides,
  };
}

describe('upsertActivity', () => {
  let athleteId: string;

  beforeAll(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Store Athlete');
  });

  it('inserts a new activity and returns its id', async () => {
    const id = await upsertActivity(athleteId, buildNormalized({ externalId: 'insert-1' }));
    const [row] = await db.select().from(activities).where(eq(activities.id, id));
    expect(row.name).toBe('Threshold intervals');
    expect(row.durationS).toBe(3600);
    expect(row.tss).toBe(85);
  });

  it('updates in place on re-import rather than creating a duplicate', async () => {
    const first = await upsertActivity(athleteId, buildNormalized({ externalId: 'dup-1' }));
    const second = await upsertActivity(
      athleteId,
      buildNormalized({ externalId: 'dup-1', name: 'Renamed ride', avgPower: 240 }),
    );

    expect(second).toBe(first);

    const rows = await db
      .select()
      .from(activities)
      .where(eq(activities.externalId, 'dup-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Renamed ride');
    expect(rows[0].avgPower).toBe(240);
  });

  it('stores missing optional metrics as null, not undefined', async () => {
    // The drift that motivated this module: one ingest path coalesced these,
    // the other did not, so the same absent metric was stored two ways.
    const sparse = buildNormalized({ externalId: 'sparse-1' }) as NormalizedActivity &
      Record<string, unknown>;
    sparse.distanceM = undefined as unknown as null;
    sparse.elevationM = undefined as unknown as null;
    sparse.tss = undefined as unknown as null;
    sparse.intensityFactor = undefined as unknown as null;

    const id = await upsertActivity(athleteId, sparse);
    const [row] = await db.select().from(activities).where(eq(activities.id, id));

    expect(row.distanceM).toBeNull();
    expect(row.elevationM).toBeNull();
    expect(row.tss).toBeNull();
    expect(row.intensityFactor).toBeNull();
  });

  it('scopes the conflict target per athlete, so two athletes can hold the same external id', async () => {
    const other = await seedAthlete('Other Athlete');
    const a = await upsertActivity(athleteId, buildNormalized({ externalId: 'shared-ext' }));
    const b = await upsertActivity(other, buildNormalized({ externalId: 'shared-ext' }));
    expect(a).not.toBe(b);
  });
});

describe('storeFitDetails', () => {
  let athleteId: string;
  let activityId: string;

  beforeAll(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Fit Athlete');
    activityId = await upsertActivity(athleteId, buildNormalized({ externalId: 'fit-1' }));
  });

  it('replaces laps and streams instead of accumulating them across re-imports', async () => {
    const parsed = {
      laps: [
        {
          lapIndex: 0,
          startedAt: new Date('2026-03-01T08:00:00Z'),
          durationS: 600,
          distanceM: 5000,
          avgPower: 200,
          maxPower: 400,
          normPower: 210,
          avgHr: 145,
          maxHr: 165,
          avgCadence: 90,
          avgSpeed: 8.3,
          elevationGain: 50,
          calories: 120,
        },
      ],
      streams: {
        timestamps: [0, 1],
        power: [200, 210],
        heartRate: [140, 145],
        cadence: [88, 90],
        speed: [8, 8.4],
        altitude: [100, 101],
        distance: [0, 8],
        temperature: [20, 20],
        lat: [41.3, 41.3],
        lng: [2.1, 2.1],
        sampleCount: 2,
      },
    } as unknown as Parameters<typeof storeFitDetails>[1];

    await storeFitDetails(activityId, parsed);
    await storeFitDetails(activityId, parsed);

    const laps = await db.select().from(activityLaps).where(eq(activityLaps.activityId, activityId));
    const streams = await db
      .select()
      .from(activityStreams)
      .where(eq(activityStreams.activityId, activityId));

    expect(laps).toHaveLength(1);
    expect(streams).toHaveLength(1);
    expect(streams[0].sampleCount).toBe(2);
  });
});

/**
 * persistActivity composes the store primitives with the derived-state updates
 * that must follow — power bests and the training-load rollup. It also used to
 * own a preamble-cache invalidation; that cache has since been removed, so the
 * test below asserts the athlete-facing property instead.
 */
describe('persistActivity', () => {
  let athleteId: string;

  beforeAll(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Ingest Athlete');
  });

  it('stores the activity and returns its id without FIT data', async () => {
    const id = await persistActivity(athleteId, buildNormalized({ externalId: 'ingest-1' }));
    const [row] = await db.select().from(activities).where(eq(activities.id, id));
    expect(row.name).toBe('Threshold intervals');
  });

  it('stores laps and streams when FIT data is supplied', async () => {
    const parsed = {
      laps: [
        {
          lapIndex: 0,
          startedAt: new Date('2026-03-01T08:00:00Z'),
          durationS: 600,
          distanceM: 5000,
          avgPower: 200,
          maxPower: 400,
          normPower: 210,
          avgHr: 145,
          maxHr: 165,
          avgCadence: 90,
          avgSpeed: 8.3,
          elevationGain: 50,
          calories: 120,
        },
      ],
      streams: {
        timestamps: [0, 1],
        power: [200, 210],
        heartRate: [140, 145],
        cadence: [88, 90],
        speed: [8, 8.4],
        altitude: [100, 101],
        distance: [0, 8],
        temperature: [20, 20],
        lat: [41.3, 41.3],
        lng: [2.1, 2.1],
        sampleCount: 2,
      },
    } as unknown as Parameters<typeof persistActivity>[2];

    const id = await persistActivity(athleteId, buildNormalized({ externalId: 'ingest-2' }), parsed);

    const laps = await db.select().from(activityLaps).where(eq(activityLaps.activityId, id));
    const streams = await db.select().from(activityStreams).where(eq(activityStreams.activityId, id));
    expect(laps).toHaveLength(1);
    expect(streams).toHaveLength(1);
  });

  it('makes a newly ingested ride visible to the coach immediately', async () => {
    const before = await buildDetailedContext(athleteId);
    expect(before).not.toContain('Brand New Ride');

    await persistActivity(
      athleteId,
      buildNormalized({ externalId: 'ingest-3', name: 'Brand New Ride', startedAt: new Date() }),
    );

    // Without the invalidation inside persistActivity this would serve the
    // primed string for the full 5-minute TTL.
    const after = await buildDetailedContext(athleteId);
    expect(after).toContain('Brand New Ride');
  });
});
