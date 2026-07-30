import { Router, type Request, type Response } from 'express';
import express from 'express';
import { db } from '../../db/client.js';
import { activities, activityLaps, athletes } from '../../db/schema.js';
import { eq, asc, desc, and, gte, lte } from 'drizzle-orm';
import { parseFitBuffer } from './fit-parser.js';
import { normalizeFitImport } from './fit-import.normalizer.js';
import { persistActivity } from './activity-ingest.js';
import { resolveAthleteId } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/error-handler.js';
import { createLogger } from '../../logger.js';

const importLog = createLogger('fit-import');

export const activitiesController: Router = Router();
activitiesController.use(resolveAthleteId);

activitiesController.get('/', asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;

  const conditions = [eq(activities.athleteId, athleteId)];
  if (from) conditions.push(gte(activities.startedAt, new Date(from + 'T00:00:00Z')));
  if (to) conditions.push(lte(activities.startedAt, new Date(to + 'T23:59:59Z')));

  const rows = await db
    .select({
      id: activities.id,
      source: activities.source,
      type: activities.type,
      name: activities.name,
      startedAt: activities.startedAt,
      durationS: activities.durationS,
      distanceM: activities.distanceM,
      avgPower: activities.avgPower,
      normPower: activities.normPower,
      tss: activities.tss,
      calories: activities.calories,
    })
    .from(activities)
    .where(and(...conditions))
    .orderBy(desc(activities.startedAt))
    .limit(limit);

  res.json({ activities: rows, hasMore: rows.length === limit });
}));

activitiesController.get('/:id', asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;
  const id = String(req.params.id);

  const [activity] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, id), eq(activities.athleteId, athleteId)))
    .limit(1);

  if (!activity) return res.status(404).json({ error: 'Activity not found' });

  const laps = await db
    .select()
    .from(activityLaps)
    .where(eq(activityLaps.activityId, id))
    .orderBy(asc(activityLaps.lapIndex));

  res.json({ ...activity, laps });
}));

// Raw-body upload: the frontend posts the .fit file's bytes directly as the
// request body (not multipart), so no extra upload middleware is needed.
activitiesController.post(
  '/import-fit',
  express.raw({ type: '*/*', limit: '20mb' }),
  asyncRoute(async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No file data received' });
    }

    const fileBytes = new Uint8Array(req.body);
    const parsed = parseFitBuffer(fileBytes);
    if (!parsed || !parsed.session) {
      return res.status(400).json({ error: 'Could not read a valid workout from this .fit file' });
    }

    const athleteId = req.athleteId;
    const [athlete] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
    const ftp = athlete?.ftp ?? undefined;

    const filename = typeof req.query.filename === 'string' ? req.query.filename : 'Imported workout';
    const fallbackName = filename.replace(/\.fit$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported workout';

    const normalized = normalizeFitImport(fileBytes, parsed, fallbackName, ftp);
    if (!normalized) {
      return res.status(400).json({ error: 'This .fit file has no session summary to import' });
    }

    const activityId = await persistActivity(athleteId, normalized, parsed);

    importLog.info('Imported activity', { name: normalized.name, type: normalized.type, durationS: normalized.durationS, athleteId });

    // No `imported: true`. On the HTTP layer the status code is the success
    // signal — a body-level boolean is a second channel saying the same thing,
    // which is exactly the per-endpoint drift the tool layer already retired
    // (`success`/`logged`/`pushed`/... -> one `ok`). The body carries data.
    res.json({
      activity: {
        id: activityId,
        name: normalized.name,
        type: normalized.type,
        startedAt: normalized.startedAt,
        durationS: normalized.durationS,
        tss: normalized.tss,
      },
    });
  }),
);
