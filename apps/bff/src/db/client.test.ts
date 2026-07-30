/**
 * The handle must open on first query, not on first import.
 *
 * At module scope, importing anything that touches persistence — transitively
 * most of the app — created a directory and opened a SQLite file. A unit test
 * for a pure function like computeBestsFromPower needed a working
 * DATABASE_PATH, and a mis-set path failed at import with a stack trace
 * pointing at db/client.ts rather than at whatever asked for a query.
 *
 * This is asserted with a deliberately invalid path: if importing opened the
 * handle, the import itself would throw. The claim is only meaningful when the
 * failure mode is available to observe.
 */
import { describe, it, expect, vi } from 'vitest';

// Each case re-imports the module under a fresh registry, which is CPU-bound
// work rather than waiting on anything. Under a loaded parallel run it has been
// seen near 10s against vitest's 5s default; slow is not the same as broken.
const REIMPORT_TIMEOUT_MS = 30_000;

const BAD_PATH = '/proc/definitely-not-writable/rumble.db';

vi.mock('../config.js', () => ({
  config: { DATABASE_PATH: BAD_PATH },
  wahooEnabled: false,
}));

describe('db/client', () => {
  it('imports without opening a connection', async () => {
    // The import is the assertion: an eager handle on an unwritable path throws
    // here, and this test cannot even reach its body.
    const mod = await import('./client.js');

    expect(typeof mod.getDb).toBe('function');
    expect(mod.db).toBeDefined();
  }, REIMPORT_TIMEOUT_MS);

  it('opens on first use, and surfaces the path failure there', async () => {
    const { getDb } = await import('./client.js');

    // Whatever the platform's complaint is, it arrives when someone asks for the
    // database — the point in the stack that can say what it wanted it for.
    expect(() => getDb()).toThrow();
  }, REIMPORT_TIMEOUT_MS);

  it('reuses one handle across calls', async () => {
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      config: { DATABASE_PATH: ':memory:' },
      wahooEnabled: false,
    }));

    const { getDb } = await import('./client.js');
    expect(getDb()).toBe(getDb());
  }, REIMPORT_TIMEOUT_MS);

  it('routes proxy property access to the real handle', async () => {
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      config: { DATABASE_PATH: ':memory:' },
      wahooEnabled: false,
    }));

    const { db, getDb } = await import('./client.js');

    // `select` is on drizzle's prototype and uses `this`; the proxy binds it to
    // the real handle so the internals never see the proxy.
    expect(typeof db.select).toBe('function');
    expect(db.select).not.toBe(getDb().select);
    expect(() => db.select()).not.toThrow();
  }, REIMPORT_TIMEOUT_MS);
});
