/**
 * getJson used to swallow every failure and return null, which made "the
 * request failed" indistinguishable from "there is nothing here". The calendar
 * rendered an offline month as a month with no rides, and a caller with no
 * failure branch waited forever for a rejection that never came.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getJson } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(impl));
}

describe('getJson', () => {
  it('returns the parsed body on 2xx', async () => {
    stubFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ hello: 'world' }) }));

    await expect(getJson<{ hello: string }>('/api/thing')).resolves.toEqual({ hello: 'world' });
  });

  it('rejects on a non-2xx rather than resolving null', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }),
    );

    // The message comes from the BFF's { error } body, so the UI can show it.
    await expect(getJson('/api/thing')).rejects.toThrow('boom');
  });

  it('falls back to the status when the error body is unreadable', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('not json')) }),
    );

    await expect(getJson('/api/thing')).rejects.toThrow('Request failed (503)');
  });

  it('propagates a network failure', async () => {
    stubFetch(() => Promise.reject(new Error('offline')));

    await expect(getJson('/api/thing')).rejects.toThrow('offline');
  });
});
