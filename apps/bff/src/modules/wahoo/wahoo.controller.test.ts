/**
 * The OAuth callback's CSRF guard.
 *
 * /callback exchanges the code it is given and binds the resulting Wahoo
 * connection to the local athlete. The `state` round-trip is the only thing
 * tying that code to a flow this app started — without it, anyone who can get
 * the athlete's browser to load the callback URL with a code from their own
 * Wahoo account attaches that account to this athlete's training data.
 *
 * These tests never let a request reach the token exchange: the state check runs
 * first, so a rejected callback is one where wahooClient was not called at all.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';

const { exchangeCodeMock } = vi.hoisted(() => ({ exchangeCodeMock: vi.fn() }));

// config is mocked so the webhook secret is set by the test rather than by
// whatever .env happens to be on the machine — "unconfigured" is one of the
// cases under test, and it cannot be asserted against an ambient value.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    // vitest.setup.ts points this at :memory:; db/client.ts reads it at import.
    DATABASE_PATH: ':memory:',
    WAHOO_WEBHOOK_TOKEN: '',
    WAHOO_CLIENT_ID: 'test-client',
    WAHOO_CLIENT_SECRET: 'test-secret',
    WAHOO_REDIRECT_URI: 'http://localhost:3001/api/wahoo/callback',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('../../config.js', () => ({ config: mockConfig, wahooEnabled: true }));

vi.mock('./wahoo.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wahoo.client.js')>();
  return {
    ...actual,
    wahooClient: {
      // The real URL builder — the state under test is the one it embeds.
      getAuthorizationUrl: actual.wahooClient.getAuthorizationUrl.bind(actual.wahooClient),
      exchangeCode: exchangeCodeMock,
      getUser: vi.fn(),
    },
  };
});

const { wahooController } = await import('./wahoo.controller.js');

function buildTestApp(athleteId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.athleteId = athleteId;
    next();
  });
  app.use('/api/wahoo', wahooController);
  return app;
}

/** Follows GET /connect and pulls the state Wahoo would send back. */
async function startFlow(app: express.Express): Promise<string> {
  const res = await request(app).get('/api/wahoo/connect');
  const state = new URL(res.headers.location).searchParams.get('state');
  expect(state, 'connect must issue a state').toBeTruthy();
  return state!;
}

describe('GET /api/wahoo/callback state validation', () => {
  let app: express.Express;

  beforeAll(async () => {
    migrateTestDb();
    const athleteId = await seedAthlete('OAuth Athlete');
    app = buildTestApp(athleteId);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    exchangeCodeMock.mockRejectedValue(new Error('exchangeCode must not be reached'));
  });

  it('rejects a callback with no state at all', async () => {
    const res = await request(app).get('/api/wahoo/callback?code=attacker-code');

    expect(res.headers.location).toContain('wahoo=error');
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it('rejects a callback whose state was never issued', async () => {
    const res = await request(app).get(
      '/api/wahoo/callback?code=attacker-code&state=not-a-real-state',
    );

    expect(res.headers.location).toContain('wahoo=error');
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it('rejects a second callback replaying an already-redeemed state', async () => {
    const state = await startFlow(app);

    // First use fails at the (mocked) exchange, which is past the state check —
    // the point is that the state is spent either way.
    await request(app).get(`/api/wahoo/callback?code=c1&state=${state}`);
    exchangeCodeMock.mockClear();

    const res = await request(app).get(`/api/wahoo/callback?code=c2&state=${state}`);

    expect(res.headers.location).toContain('wahoo=error');
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it('accepts the state it issued, reaching the code exchange', async () => {
    const state = await startFlow(app);

    await request(app).get(`/api/wahoo/callback?code=real-code&state=${state}`);

    expect(exchangeCodeMock).toHaveBeenCalledWith('real-code');
  });

  it('issues a distinct state per connect', async () => {
    const [a, b] = [await startFlow(app), await startFlow(app)];
    expect(a).not.toBe(b);
  });

  it('still answers 400 for a missing code', async () => {
    const res = await request(app).get('/api/wahoo/callback');

    expect(res.status).toBe(400);
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });
});

/**
 * The webhook triggers a sync for whichever athlete its payload names, so it is
 * an authenticated endpoint whose only credential is a shared secret.
 *
 * Two failure modes worth pinning. WAHOO_WEBHOOK_TOKEN defaults to '' and
 * wahooEnabled only requires the client id and secret, so a deployment without
 * the webhook token would mount this route with an empty expected value — and a
 * caller sending `webhook_token: ''` compares equal. And a plain `!==` on the
 * secret short-circuits at the first differing byte, which over many requests
 * leaks it one byte at a time.
 */
describe('POST /api/wahoo/webhook authentication', () => {
  let app: express.Express;

  beforeAll(async () => {
    migrateTestDb();
    const athleteId = await seedAthlete('Webhook Athlete');
    app = buildTestApp(athleteId);
  });

  afterEach(() => {
    mockConfig.WAHOO_WEBHOOK_TOKEN = '';
  });

  it('fails closed with 503 when no webhook token is configured', async () => {
    mockConfig.WAHOO_WEBHOOK_TOKEN = '';

    const res = await request(app)
      .post('/api/wahoo/webhook')
      .send({ webhook_token: '', event_type: 'workout_summary', user: { id: 1 } });

    // Not 401: an empty presented token equals an empty expected one, so string
    // comparison alone would have let this through.
    expect(res.status).toBe(503);
  });

  it('rejects a wrong token with 401', async () => {
    mockConfig.WAHOO_WEBHOOK_TOKEN = 'the-real-secret';

    const res = await request(app)
      .post('/api/wahoo/webhook')
      .send({ webhook_token: 'not-the-secret', event_type: 'workout_summary', user: { id: 1 } });

    expect(res.status).toBe(401);
  });

  it('rejects a token that is a prefix of the secret', async () => {
    // timingSafeEqual needs equal-length buffers; the length check has to come
    // first or this throws instead of rejecting.
    mockConfig.WAHOO_WEBHOOK_TOKEN = 'the-real-secret';

    const res = await request(app)
      .post('/api/wahoo/webhook')
      .send({ webhook_token: 'the-real', event_type: 'workout_summary', user: { id: 1 } });

    expect(res.status).toBe(401);
  });

  it('rejects a non-string token without throwing', async () => {
    mockConfig.WAHOO_WEBHOOK_TOKEN = 'the-real-secret';

    const res = await request(app)
      .post('/api/wahoo/webhook')
      .send({ webhook_token: { $ne: null }, event_type: 'workout_summary' });

    expect(res.status).toBe(401);
  });

  it('accepts the configured token and acknowledges the event', async () => {
    mockConfig.WAHOO_WEBHOOK_TOKEN = 'the-real-secret';

    // A non-workout_summary event acknowledges without triggering a sync, which
    // keeps this test to the authentication path.
    const res = await request(app)
      .post('/api/wahoo/webhook')
      .send({ webhook_token: 'the-real-secret', event_type: 'something_else' });

    expect(res.status).toBe(200);
  });
});
