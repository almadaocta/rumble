/**
 * The Wahoo HTTP boundary.
 *
 * Everything here talks to a third party over the network, so the parts worth
 * pinning are the ones that decide what happens when that party misbehaves:
 * that a non-2xx becomes a labelled error rather than a silent undefined, and
 * that the OAuth URL carries the scopes the callback later stores.
 *
 * `fetch` is stubbed — this asserts the client's own contract, not Wahoo's.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { wahooClient } from './wahoo.client.js';

function mockFetch(status: number, body: unknown, ok = status < 400) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAuthorizationUrl', () => {
  const STATE = 'a-random-state';

  it('points at Wahoo and requests an authorization code', () => {
    const url = new URL(wahooClient.getAuthorizationUrl(STATE));

    expect(url.origin).toBe('https://api.wahooligan.com');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('carries the CSRF state through to Wahoo', () => {
    // Without this on the URL there is nothing for /callback to check the
    // returned code against, and it will bind any code it is handed.
    const url = new URL(wahooClient.getAuthorizationUrl(STATE));

    expect(url.searchParams.get('state')).toBe(STATE);
  });

  it('requests every scope the app later relies on', () => {
    const scope = new URL(wahooClient.getAuthorizationUrl(STATE)).searchParams.get('scope') ?? '';

    // Each of these backs a feature: reading workouts, pushing planned
    // sessions to the head unit, and syncing power zones.
    for (const required of [
      'user_read',
      'workouts_read',
      'workouts_write',
      'plans_write',
      'power_zones_read',
      'power_zones_write',
    ]) {
      expect(scope.split(' '), required).toContain(required);
    }
  });
});

describe('error handling', () => {
  it('labels a failed code exchange with its status and body', async () => {
    mockFetch(401, 'invalid_grant', false);

    await expect(wahooClient.exchangeCode('bad-code')).rejects.toThrow(/401/);
    await expect(wahooClient.exchangeCode('bad-code')).rejects.toThrow(/invalid_grant/);
  });

  it('labels a failed GET with the path that failed', async () => {
    mockFetch(500, 'upstream boom', false);

    // Which endpoint broke is the first thing you want from a log line.
    await expect(wahooClient.getUser('token')).rejects.toThrow(/failed \(500\)/);
  });

  it('does not swallow a failure into a resolved undefined', async () => {
    mockFetch(403, 'forbidden', false);

    const result = await wahooClient.getUser('token').catch((e: Error) => e);
    expect(result).toBeInstanceOf(Error);
  });

  it('returns the parsed body on success', async () => {
    mockFetch(200, { id: 42, email: 'rider@example.invalid' });

    await expect(wahooClient.getUser('token')).resolves.toMatchObject({ id: 42 });
  });

  it('sends the bearer token on authenticated calls', async () => {
    const fn = mockFetch(200, { id: 1 });
    await wahooClient.getUser('secret-token');

    const [, init] = fn.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer secret-token');
  });
});
