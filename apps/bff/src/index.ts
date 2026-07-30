import './env.js';
import express from 'express';
import cors from 'cors';
import { config, wahooEnabled } from './config.js';
import { chatController } from './modules/chat/chat.controller.js';
import { activitiesController } from './modules/activities/activities.controller.js';
import { athleteController } from './modules/athlete/athlete.controller.js';
import { nutritionController } from './modules/nutrition/nutrition.controller.js';
import { getDefaultAthleteId } from './db/athlete.js';
import { createLogger, describeError } from './logger.js';
import { jsonErrorHandler, notFoundHandler } from './middleware/error-handler.js';

const log = createLogger('server');
const metricsLog = createLogger('metrics');

const app = express();

app.use(cors({ origin: config.FRONTEND_URL }));
app.use(express.json({ limit: '1mb' }));

// Health check first, before athlete resolution — it shouldn't need an athlete to exist.
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    wahoo: wahooEnabled,
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/chat', chatController);
// Not gated behind wahooEnabled: manual .fit import works without any Wahoo
// app/OAuth setup, so activity data is always readable/importable.
app.use('/api/activities', activitiesController);
app.use('/api/athlete', athleteController);
app.use('/api/nutrition', nutritionController);

// Top-level await, not import().then(): Express dispatches in registration
// order, and the terminal /api 404 handler below is registered synchronously.
// Deferring this mount to a later microtask put the catch-all in front of the
// Wahoo router and made every /api/wahoo/* route answer 404.
if (wahooEnabled) {
  try {
    const { wahooController } = await import('./modules/wahoo/wahoo.controller.js');
    app.use('/api/wahoo', wahooController);
    log.info('Wahoo integration enabled');
  } catch (err) {
    log.error('Failed to load Wahoo integration', describeError(err));
  }
} else {
  log.info('Wahoo integration disabled — chat-only mode');
}

// Daily fitness-metrics rollup (CTL/ATL/TSB decay even on rest days), run
// in-process — no job queue for a single local user. wahoo.sync.ts already
// recomputes metrics synchronously right after a sync, so this just covers
// days with no new activity.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
async function runDailyMetricsRollup(): Promise<void> {
  const athleteId = await getDefaultAthleteId().catch(() => null);
  if (!athleteId) return;
  const { recomputeTodayMetrics } = await import('./modules/metrics/metrics.service.js');

  await recomputeTodayMetrics(athleteId);
  metricsLog.info('Daily rollup complete');
}
setInterval(() => {
  runDailyMetricsRollup().catch((err) => metricsLog.error('Daily rollup failed', describeError(err)));
}, ONE_DAY_MS);

// Terminal handlers, mounted last so every /api route answers JSON — including
// the next(err) path out of resolveAthleteId, which Express would otherwise
// answer with an HTML error page the web client cannot parse.
app.use('/api', notFoundHandler);
app.use(jsonErrorHandler);

app.listen(config.PORT, () => {
  log.info('RUMBLE BFF listening', { port: config.PORT });
  log.info('Frontend origin', { url: config.FRONTEND_URL });
  log.info('Health endpoint', { url: `http://localhost:${config.PORT}/api/health` });
});
