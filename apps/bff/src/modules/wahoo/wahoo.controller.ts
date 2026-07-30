import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { activities, wahooConnections } from '../../db/schema.js';
import { eq, count } from 'drizzle-orm';
import { wahooClient, WAHOO_SCOPES } from './wahoo.client.js';
import { wahooTokenManager } from './wahoo.token-manager.js';
import { syncUserProfile, syncPowerZones, syncFullHistory, syncNewWorkout } from './wahoo.sync.js';
import { resolveAthleteId } from '../../middleware/auth.js';
import { asyncRoute } from '../../middleware/error-handler.js';
import { createLogger, describeError } from '../../logger.js';

const log = createLogger('wahoo');
const syncLog = createLogger('wahoo-sync');
const webhookLog = createLogger('wahoo-webhook');

export const wahooController: Router = Router();

// Applied per-route, not globally: /webhook is called by Wahoo's servers,
// not our app, and authenticates via its own webhook token — it resolves
// its athlete from the Wahoo user id in the payload, not from req.athleteId,
// and must keep working even before any local athlete exists. /connect
// doesn't need an athlete at all (it's just a redirect to Wahoo's OAuth
// page). Only the routes that actually read req.athleteId get the middleware.

// No job queue for a single local user — sync runs in-process. This is both the
// concurrency guard and what /status reports as "currently syncing".
interface SyncState {
  startedAt: number;
  lastError?: string;
}

/**
 * In-flight and last-outcome state per athlete.
 *
 * The last error is kept, not just the in-flight flag. A full-history sync is
 * fire-and-forget, so a throw leaves nothing but a server log line: the UI's
 * spinner stops and the athlete cannot tell "finished" from "died halfway".
 * /status reads this to say which.
 */
const syncState = new Map<string, SyncState>();
const lastSyncError = new Map<string, string>();

/**
 * Runs a full-history sync unless one is already in flight for this athlete.
 *
 * The in-flight check has to gate the start, not just feed /status: without it
 * a second call begins a concurrent import of the same account, two passes
 * writing the same activities and recomputing metrics underneath each other.
 * Returns false when one was already running, so the caller can say so rather
 * than reporting a fresh sync as queued.
 */
function startFullHistorySync(athleteId: string): boolean {
  if (syncState.has(athleteId)) return false;
  syncState.set(athleteId, { startedAt: Date.now() });
  lastSyncError.delete(athleteId);

  void (async () => {
    try {
      const result = await syncFullHistory(athleteId);
      syncLog.info('Full history complete', { imported: result.imported });
    } catch (err) {
      const { error } = describeError(err);
      lastSyncError.set(athleteId, String(error));
      syncLog.error('Full history sync failed', describeError(err));
    } finally {
      syncState.delete(athleteId);
    }
  })();

  return true;
}

/**
 * Unredeemed OAuth `state` values, with expiry.
 *
 * The only thing tying a code arriving at /callback to a flow this app actually
 * started. Without it the callback exchanges whatever code it is handed and
 * binds the resulting connection to the local athlete, so anyone who can get
 * the athlete's browser to load the callback URL with a code from their own
 * Wahoo account attaches that account to this athlete's training data.
 *
 * In memory because it is genuinely short-lived and per-process: a restart
 * mid-authorization means the athlete clicks Connect again, which is the right
 * outcome for a value that must not survive its flow.
 */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const pendingOAuthStates = new Map<string, number>();

function issueOAuthState(): string {
  // Opportunistic sweep — this map only grows when an athlete abandons a flow.
  const now = Date.now();
  for (const [value, expiresAt] of pendingOAuthStates) {
    if (expiresAt <= now) pendingOAuthStates.delete(value);
  }

  const state = randomUUID();
  pendingOAuthStates.set(state, now + OAUTH_STATE_TTL_MS);
  return state;
}

/** Single-use: a state is consumed whether or not it was still valid. */
function consumeOAuthState(state: unknown): boolean {
  if (typeof state !== 'string') return false;
  const expiresAt = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
  return expiresAt != null && expiresAt > Date.now();
}

wahooController.get('/connect', async (_req: Request, res: Response) => {
  res.redirect(wahooClient.getAuthorizationUrl(issueOAuthState()));
});

wahooController.get('/callback', resolveAthleteId, async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    if (!code) {
      res.status(400).json({ error: 'Missing authorization code' });
      return;
    }

    if (!consumeOAuthState(req.query.state)) {
      log.warn('OAuth callback rejected: unrecognized or expired state');
      res.redirect(`${config.FRONTEND_URL}?wahoo=error`);
      return;
    }

    const tokens = await wahooClient.exchangeCode(code);
    const user = await wahooClient.getUser(tokens.access_token);

    const athleteId = req.athleteId;
    await wahooTokenManager.storeTokens(
      athleteId,
      String(user.id),
      tokens,
      WAHOO_SCOPES,
    );

    await syncUserProfile(athleteId);
    await syncPowerZones(athleteId);

    // Fire-and-forget: full history can take a while, don't block the redirect.
    startFullHistorySync(athleteId);

    res.redirect(`${config.FRONTEND_URL}?wahoo=connected`);
  } catch (err) {
    // Kept, unlike the read routes: this is a browser redirect target, so the
    // athlete needs to land back on the app with ?wahoo=error, not read a JSON
    // 500 body in their address bar.
    log.error('OAuth callback failed', describeError(err));
    res.redirect(`${config.FRONTEND_URL}?wahoo=error`);
  }
});

/**
 * Constant-time comparison against the configured webhook secret.
 *
 * `!==` on strings short-circuits at the first differing byte, which leaks the
 * length of the shared prefix to anyone who can time the response — enough, over
 * many requests, to recover a secret one byte at a time. timingSafeEqual needs
 * equal-length buffers, so the length check comes first and is deliberately not
 * constant-time: the length of a configured secret is not the secret.
 *
 * Callers must confirm WAHOO_WEBHOOK_TOKEN is set before reaching here — this
 * returns false for an unset secret, but the caller owes the athlete a clearer
 * 503 than a bare 401.
 */
function webhookTokenMatches(presented: unknown): boolean {
  if (typeof presented !== 'string' || !config.WAHOO_WEBHOOK_TOKEN) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(config.WAHOO_WEBHOOK_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

wahooController.post('/webhook', async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    // Fail closed on an unset secret. WAHOO_WEBHOOK_TOKEN defaults to '' and
    // wahooEnabled only requires the client id/secret, so a deployment without
    // it would accept any caller that simply sent `webhook_token: ''` — the
    // comparison below would match. This webhook triggers a sync for whichever
    // athlete the payload names, so it has to be authenticated.
    if (!config.WAHOO_WEBHOOK_TOKEN) {
      webhookLog.error('Webhook rejected: WAHOO_WEBHOOK_TOKEN is not configured');
      res.status(503).json({ error: 'Webhook not configured' });
      return;
    }

    if (!webhookTokenMatches(payload.webhook_token)) {
      res.status(401).json({ error: 'Invalid webhook token' });
      return;
    }

    if (payload.event_type !== 'workout_summary') {
      res.sendStatus(200);
      return;
    }

    const wahooUserId = String(payload.user?.id);
    const conn = await wahooTokenManager.getConnectionByWahooUserId(wahooUserId);

    if (!conn) {
      webhookLog.warn('Unknown Wahoo user', { wahooUserId });
      res.sendStatus(200);
      return;
    }

    // Fire-and-forget: acknowledge the webhook immediately, sync in the background.
    void syncNewWorkout(conn.athleteId, payload.workout_summary).catch((err) => {
      webhookLog.error('Single-workout sync failed', describeError(err));
    });

    res.sendStatus(200);
  } catch (err) {
    // Kept, unlike the read routes: the caller is Wahoo's server, which reads the
    // status code to decide whether to retry and has no use for a JSON body.
    webhookLog.error('Webhook handling failed', describeError(err));
    res.sendStatus(500);
  }
});

wahooController.post('/sync', resolveAthleteId, asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;
  const started = startFullHistorySync(athleteId);
  res.json(
    started
      ? { queued: true, message: 'Full history sync started' }
      : { queued: false, message: 'A full history sync is already running' },
  );
}));

wahooController.delete('/disconnect', resolveAthleteId, asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;
  await wahooTokenManager.deleteConnection(athleteId);
  // 204: nothing to say beyond "it worked", and the status already says that.
  res.sendStatus(204);
}));

wahooController.get('/status', resolveAthleteId, asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;
  const [connection] = await db
    .select()
    .from(wahooConnections)
    .where(eq(wahooConnections.athleteId, athleteId))
    .limit(1);

  if (!connection) {
    res.json({ connected: false, syncStatus: 'idle', activityCount: 0 });
    return;
  }

  const syncError = lastSyncError.get(athleteId);
  const syncStatus: 'idle' | 'syncing' | 'complete' | 'failed' = syncState.has(athleteId)
    ? 'syncing'
    : syncError
      ? 'failed'
      : connection.lastSyncAt
        ? 'complete'
        : 'idle';

  const [{ value: activityCount }] = await db
    .select({ value: count() })
    .from(activities)
    .where(eq(activities.athleteId, athleteId));

  res.json({
    connected: true,
    // camelCase, matching the schema fields these come from and every other
    // key in this payload. snake_case here was leaking a naming convention
    // this app reserves for the LLM and DB boundaries into the web client.
    wahooUserId: connection.wahooUserId,
    lastSyncAt: connection.lastSyncAt,
    tokenExpiresAt: connection.tokenExpiresAt,
    syncStatus,
    ...(syncError ? { lastSyncError: syncError } : {}),
    activityCount,
  });
}));
