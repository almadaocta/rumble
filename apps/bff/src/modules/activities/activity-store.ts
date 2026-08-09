/**
 * The one place a normalized activity becomes rows in the database.
 *
 * Both ingest paths — Wahoo sync and the manual `/import-fit` upload — go
 * through here, which is what keeps the column semantics single-valued. When
 * this existed twice the copies disagreed about "missing": one coalesced
 * `distanceM`, `elevationM`, `tss`, `intensityFactor`, `avgSpeed` and
 * `elevationGain` to null and the other passed `undefined` straight through, so
 * the same table meant two different things depending on where the ride came
 * from. Add a nullable column here, not at a call site.
 */
import { db } from '../../db/client.js';
import { activities, activityLaps, activityStreams } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import type { NormalizedActivity } from './normalized-activity.js';
import type { ParsedFitFile } from './fit-parser.js';

/**
 * Whether an activity for this (athleteId, source, externalId) has already
 * been imported. Wahoo sync uses this to stop paging once it reaches
 * already-known workouts, rather than re-fetching and re-parsing FIT files
 * for activities that haven't changed.
 */
export async function activityExists(
  athleteId: string,
  source: string,
  externalId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(
        eq(activities.athleteId, athleteId),
        eq(activities.source, source),
        eq(activities.externalId, externalId),
      ),
    )
    .limit(1);
  return row != null;
}

/**
 * Inserts a normalized activity, or updates it in place when the
 * (athleteId, source, externalId) triple already exists. Returns the row id.
 *
 * Deliberately does not touch laps, streams, bests or metrics — callers compose
 * those steps, because the two ingest paths need them in different orders.
 */
export async function upsertActivity(
  athleteId: string,
  normalized: NormalizedActivity,
): Promise<string> {
  // Fields shared by the insert and the conflict-update. `fitFileUrl` and the
  // identity columns are insert-only, so they stay out of here.
  const mutableColumns = {
    name: normalized.name,
    durationS: normalized.durationS,
    distanceM: normalized.distanceM ?? null,
    avgPower: normalized.avgPower,
    normPower: normalized.normPower,
    maxPower: normalized.maxPower,
    avgHr: normalized.avgHr,
    maxHr: normalized.maxHr,
    avgCadence: normalized.avgCadence,
    elevationM: normalized.elevationM ?? null,
    calories: normalized.calories,
    tss: normalized.tss ?? null,
    intensityFactor: normalized.intensityFactor ?? null,
  };

  const [row] = await db
    .insert(activities)
    .values({
      athleteId,
      source: normalized.source,
      externalId: normalized.externalId,
      type: normalized.type,
      startedAt: normalized.startedAt,
      fitFileUrl: normalized.fitFileUrl ?? null,
      ...mutableColumns,
    })
    .onConflictDoUpdate({
      target: [activities.athleteId, activities.source, activities.externalId],
      set: { ...mutableColumns, fitFileUrl: normalized.fitFileUrl ?? null },
    })
    .returning({ id: activities.id });

  return row.id;
}

/**
 * Replaces the lap and stream rows for an activity from a parsed FIT file.
 *
 * Delete-then-insert rather than upsert: a re-import is authoritative, and lap
 * indices shift when a file is re-recorded, so merging would leave orphans.
 */
export async function storeFitDetails(activityId: string, parsed: ParsedFitFile): Promise<void> {
  if (parsed.laps.length > 0) {
    await db.delete(activityLaps).where(eq(activityLaps.activityId, activityId));
    await db.insert(activityLaps).values(
      parsed.laps.map((lap) => ({
        activityId,
        lapIndex: lap.lapIndex,
        startedAt: lap.startedAt,
        durationS: lap.durationS,
        distanceM: lap.distanceM ?? null,
        avgPower: lap.avgPower,
        maxPower: lap.maxPower,
        normPower: lap.normPower,
        avgHr: lap.avgHr,
        maxHr: lap.maxHr,
        avgCadence: lap.avgCadence,
        avgSpeed: lap.avgSpeed ?? null,
        elevationGain: lap.elevationGain ?? null,
        calories: lap.calories,
      })),
    );
  }

  if (parsed.streams.sampleCount > 0) {
    await db.delete(activityStreams).where(eq(activityStreams.activityId, activityId));
    await db.insert(activityStreams).values({
      activityId,
      timestamps: parsed.streams.timestamps,
      power: parsed.streams.power,
      heartRate: parsed.streams.heartRate,
      cadence: parsed.streams.cadence,
      speed: parsed.streams.speed,
      altitude: parsed.streams.altitude,
      distance: parsed.streams.distance,
      temperature: parsed.streams.temperature,
      lat: parsed.streams.lat,
      lng: parsed.streams.lng,
      sampleCount: parsed.streams.sampleCount,
    });
  }
}
