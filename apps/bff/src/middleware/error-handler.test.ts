/**
 * Tests for the terminal JSON handlers, plus a regression test for the
 * registration-order trap they introduced.
 *
 * `notFoundHandler` is mounted at `/api` and is terminal. Express dispatches in
 * registration order, so anything mounted *after* it — for example a router
 * added inside an `import().then()` callback, which resolves on a later
 * microtask — becomes unreachable and answers 404. That is exactly what
 * happened to `/api/wahoo/*`.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { asyncRoute, jsonErrorHandler, notFoundHandler } from './error-handler.js';

/** Minimal fetch against an ephemeral listener, so no supertest dependency. */
async function call(
  app: express.Express,
  path: string,
  timeoutMs = 2000,
): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0);
  try {
    const { port } = server.address() as { port: number };
    // A timeout, because the failure mode under test for asyncRoute is a request
    // that never answers at all — without it that case hangs the suite.
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the raw text so we can assert it is *not* JSON */
    }
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

describe('notFoundHandler', () => {
  it('answers unmatched /api routes with JSON, not Express HTML', async () => {
    const app = express();
    app.use('/api', notFoundHandler);
    app.use(jsonErrorHandler);

    const { status, body } = await call(app, '/api/nope');
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: expect.stringContaining('/nope') });
  });

  it('does not shadow a router registered before it', async () => {
    const app = express();
    const router = express.Router();
    router.get('/status', (_req, res) => {
      res.json({ connected: true });
    });

    app.use('/api/wahoo', router);
    app.use('/api', notFoundHandler);

    const { status, body } = await call(app, '/api/wahoo/status');
    expect(status).toBe(200);
    expect(body).toEqual({ connected: true });
  });

  it('DOES shadow a router registered after it — the trap this guards against', async () => {
    const app = express();
    app.use('/api', notFoundHandler);

    // Simulates mounting inside an import().then() callback: same code, later tick.
    const router = express.Router();
    router.get('/status', (_req, res) => {
      res.json({ connected: true });
    });
    app.use('/api/wahoo', router);

    const { status } = await call(app, '/api/wahoo/status');
    expect(status).toBe(404); // documents why index.ts must await the dynamic import
  });
});

describe('jsonErrorHandler', () => {
  it('converts a thrown route error into the { error } contract', async () => {
    const app = express();
    app.get('/api/boom', () => {
      throw new Error('internal detail that must not leak');
    });
    app.use(jsonErrorHandler);

    const { status, body } = await call(app, '/api/boom');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('internal detail');
  });

  it('converts a next(err) rejection the same way', async () => {
    const app = express();
    app.get('/api/next-err', (_req, _res, next) => {
      next(new Error('identity resolution failed'));
    });
    app.use(jsonErrorHandler);

    const { status, body } = await call(app, '/api/next-err');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });
  });
});

/**
 * Express 4 does not await route handlers, so a rejected async handler is an
 * unhandled rejection: the error handler never runs and the request hangs until
 * the client gives up. Every route that dropped its own log-and-500 catch block
 * depends on asyncRoute closing that gap.
 */
describe('asyncRoute', () => {
  it('forwards a rejected async handler to the error handler', async () => {
    const app = express();
    app.get(
      '/api/async-boom',
      asyncRoute(async () => {
        throw new Error('the query blew up');
      }),
    );
    app.use(jsonErrorHandler);

    const { status, body } = await call(app, '/api/async-boom');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal server error' });
  });

  it('forwards a rejection from an awaited call, not just a synchronous throw', async () => {
    const app = express();
    app.get(
      '/api/async-await-boom',
      asyncRoute(async () => {
        await Promise.resolve();
        return Promise.reject(new Error('rejected after a tick'));
      }),
    );
    app.use(jsonErrorHandler);

    const { status } = await call(app, '/api/async-await-boom');
    expect(status).toBe(500);
  });

  it('leaves a handler that answers normally alone', async () => {
    const app = express();
    app.get(
      '/api/fine',
      asyncRoute(async (_req, res) => {
        await Promise.resolve();
        res.json({ ok: true });
      }),
    );
    app.use(jsonErrorHandler);

    expect(await call(app, '/api/fine')).toMatchObject({ status: 200, body: { ok: true } });
  });
});
