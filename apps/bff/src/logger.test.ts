import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger, redact, describeError, setLogLevel, getLogLevel } from './logger.js';

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel('silent');
});

describe('redact', () => {
  it('masks credential-shaped keys regardless of value shape', () => {
    expect(redact({ apiKey: 'plain-looking', token: 'x', name: 'keep' })).toEqual({
      apiKey: '[redacted]',
      token: '[redacted]',
      name: 'keep',
    });
  });

  it('matches key names case-insensitively and with separators', () => {
    expect(redact({ API_KEY: 'a', 'api-key': 'b', Authorization: 'c', refreshToken: 'd' })).toEqual({
      API_KEY: '[redacted]',
      'api-key': '[redacted]',
      Authorization: '[redacted]',
      refreshToken: '[redacted]',
    });
  });

  it('recurses into nested objects and arrays', () => {
    expect(redact({ outer: { secret: 's', ok: 1 }, list: [{ password: 'p' }] })).toEqual({
      outer: { secret: '[redacted]', ok: 1 },
      list: [{ password: '[redacted]' }],
    });
  });

  it('stops at the depth limit rather than recursing without bound', () => {
    const deep = { a: { b: { c: { d: { secret: 'buried' } } } } };
    // depth 4 is consumed by a/b/c/d, so the innermost secret is returned untouched
    expect(redact(deep)).toEqual({ a: { b: { c: { d: { secret: 'buried' } } } } });
  });

  it('passes primitives through', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });
});

describe('describeError', () => {
  it('extracts the message from an Error, which JSON.stringify would drop', () => {
    expect(JSON.stringify(new Error('boom'))).toBe('{}');
    expect(describeError(new Error('boom')).error).toBe('boom');
  });

  it('stringifies non-Error throwables', () => {
    expect(describeError('just a string')).toEqual({ error: 'just a string' });
    expect(describeError(404)).toEqual({ error: '404' });
  });
});

describe('level filtering', () => {
  it('suppresses messages below the active level', () => {
    setLogLevel('warn');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const log = createLogger('scope');
    log.info('hidden');
    log.warn('shown');

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('emits nothing at all when silent', () => {
    setLogLevel('silent');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('scope').error('not emitted');
    expect(error).not.toHaveBeenCalled();
  });

  it('returns the previous level so callers can restore it', () => {
    setLogLevel('warn');
    const previous = setLogLevel('debug');
    expect(previous).toBe('warn');
    expect(getLogLevel()).toBe('debug');
  });
});

describe('formatting', () => {
  it('prefixes the scope and appends serialized context', () => {
    setLogLevel('debug');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    createLogger('wahoo-sync').info('Synced', { imported: 3 });
    expect(info).toHaveBeenCalledWith('[wahoo-sync] Synced {"imported":3}');
  });

  it('omits the context object entirely when there is none', () => {
    setLogLevel('debug');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    createLogger('server').info('Listening');
    expect(info).toHaveBeenCalledWith('[server] Listening');
  });

  it('redacts secrets on the way out', () => {
    setLogLevel('debug');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    createLogger('wahoo').info('Token refreshed', { refreshToken: 'super-secret', athleteId: 'a1' });
    const line = info.mock.calls[0][0] as string;
    expect(line).not.toContain('super-secret');
    expect(line).toContain('[redacted]');
    expect(line).toContain('a1');
  });
});
