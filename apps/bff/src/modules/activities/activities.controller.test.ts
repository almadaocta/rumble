/**
 * The read API behind the calendar: a windowed list, and a detail row with laps.
 *
 * Three things here are easy to get wrong in ways that look right. The date
 * window is built from `from`/`to` date strings widened to a UTC day boundary, so
 * an activity late on the last day of a month is either in the calendar or
 * silently missing. `hasMore` is derived from the row count hitting the limit, so
 * the limit has to be clamped or a client can ask for the whole history. And
 * both routes are athlete-scoped, which is the only thing stopping one athlete
 * reading another's rides by id.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { activities, activityLaps } from '../../db/schema.js';
import { activitiesController } from './activities.controller.js';

function buildTestApp(athleteId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.athleteId = athleteId;
    next();
  });
  app.use('/api/activities', activitiesController);
  return app;
}

function ride(athleteId: string, externalId: string, startedAt: string, extra = {}) {
  return {
    athleteId,
    externalId,
    source: 'manual',
    type: 'ride',
    name: `ride ${externalId}`,
    startedAt: new Date(startedAt),
    durationS: 3600,
    ...extra,
  };
}

let athleteId: string;
let app: express.Express;

beforeEach(async () => {
  migrateTestDb();
  athleteId = await seedAthlete('Calendar Athlete');
  app = buildTestApp(athleteId);
});

describe('GET /api/activities', () => {
  beforeEach(async () => {
    await db.insert(activities).values([
      ride(athleteId, 'jan', '2026-01-15T09:00:00Z'),
      ride(athleteId, 'feb-first', '2026-02-01T00:30:00Z'),
      ride(athleteId, 'feb-last', '2026-02-28T23:30:00Z'),
      ride(athleteId, 'mar', '2026-03-02T09:00:00Z'),
    ]);
  });

  it('returns the athlete\'s activities, newest first', async () => {
    const { activities: rows } = (await request(app).get('/api/activities')).body;

    expect(rows.map((r: { externalId: string; name: string }) => r.name)).toEqual([
      'ride mar',
      'ride feb-last',
      'ride feb-first',
      'ride jan',
    ]);
  });

  it('includes both edges of a from/to window', async () => {
    // The boundary cases: a ride 30 minutes into the first day and 30 minutes
    // before midnight on the last. `to` widens to 23:59:59, so both belong.
    const { activities: rows } = (
      await request(app).get('/api/activities?from=2026-02-01&to=2026-02-28')
    ).body;

    expect(rows.map((r: { name: string }) => r.name).sort()).toEqual([
      'ride feb-first',
      'ride feb-last',
    ]);
  });

  it('excludes activities outside the window', async () => {
    const { activities: rows } = (
      await request(app).get('/api/activities?from=2026-02-01&to=2026-02-28')
    ).body;

    const names = rows.map((r: { name: string }) => r.name);
    expect(names).not.toContain('ride jan');
    expect(names).not.toContain('ride mar');
  });

  it('reports hasMore only when the page is full', async () => {
    const full = (await request(app).get('/api/activities?limit=2')).body;
    expect(full.activities).toHaveLength(2);
    expect(full.hasMore).toBe(true);

    const partial = (await request(app).get('/api/activities?limit=50')).body;
    expect(partial.activities).toHaveLength(4);
    expect(partial.hasMore).toBe(false);
  });

  it('clamps the limit rather than trusting the query', async () => {
    const res = await request(app).get('/api/activities?limit=100000');

    // Capped at 200; with four rows the visible effect is that the request
    // succeeds and hasMore is honest.
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
  });

  it('ignores a non-numeric limit instead of returning nothing', async () => {
    const res = await request(app).get('/api/activities?limit=abc');

    expect(res.body.activities).toHaveLength(4);
  });

  it('never returns another athlete\'s activities', async () => {
    const other = await seedAthlete('Someone Else');
    await db.insert(activities).values(ride(other, 'theirs', '2026-02-10T09:00:00Z'));

    const { activities: rows } = (await request(app).get('/api/activities')).body;

    expect(rows.map((r: { name: string }) => r.name)).not.toContain('ride theirs');
  });
});

describe('GET /api/activities/:id', () => {
  let activityId: string;

  beforeEach(async () => {
    const [row] = await db
      .insert(activities)
      .values(ride(athleteId, 'detail', '2026-02-10T09:00:00Z', { avgPower: 210, tss: 80 }))
      .returning();
    activityId = row.id;
  });

  it('returns the full row', async () => {
    const res = await request(app).get(`/api/activities/${activityId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: activityId, avgPower: 210, durationS: 3600 });
  });

  it('includes laps in lap order', async () => {
    // Inserted out of order on purpose: the endpoint sorts by lapIndex, and
    // insertion order is not a guarantee SQLite makes.
    await db.insert(activityLaps).values([
      { activityId, lapIndex: 2, startedAt: new Date('2026-02-10T09:15:00Z'), durationS: 300, avgPower: 240 },
      { activityId, lapIndex: 0, startedAt: new Date('2026-02-10T09:00:00Z'), durationS: 600, avgPower: 180 },
      { activityId, lapIndex: 1, startedAt: new Date('2026-02-10T09:10:00Z'), durationS: 300, avgPower: 250 },
    ]);

    const { laps } = (await request(app).get(`/api/activities/${activityId}`)).body;

    expect(laps.map((l: { lapIndex: number }) => l.lapIndex)).toEqual([0, 1, 2]);
  });

  it('returns an empty lap list rather than omitting the key', async () => {
    const { laps } = (await request(app).get(`/api/activities/${activityId}`)).body;

    // The web client maps over this unconditionally.
    expect(laps).toEqual([]);
  });

  it('404s an unknown id', async () => {
    const res = await request(app).get('/api/activities/00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Activity not found' });
  });

  it('404s another athlete\'s activity rather than serving it', async () => {
    const other = await seedAthlete('Someone Else');
    const [theirs] = await db
      .insert(activities)
      .values(ride(other, 'theirs', '2026-02-11T09:00:00Z'))
      .returning();

    const res = await request(app).get(`/api/activities/${theirs.id}`);

    // 404, not 403: whether the id exists is not this athlete's business.
    expect(res.status).toBe(404);
  });
});

describe('POST /api/activities/import-fit', () => {
  it('rejects an empty body', async () => {
    const res = await request(app)
      .post('/api/activities/import-fit')
      .set('Content-Type', 'application/octet-stream')
      .send();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'No file data received' });
  });

  it('rejects bytes that are not a readable .fit file', async () => {
    const res = await request(app)
      .post('/api/activities/import-fit?filename=notafit.fit')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('this is not a fit file, it is a sentence'));

    expect(res.status).toBe(400);
    // The athlete gets told what was wrong with their file, not a 500.
    expect(String(res.body.error)).toMatch(/fit file/i);
  });
});
