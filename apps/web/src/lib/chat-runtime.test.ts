// @vitest-environment jsdom
/**
 * loadInitialMessages restores a previous conversation from the BFF.
 *
 * The filtering is the part worth pinning: turns that involved tools also
 * persist raw Anthropic content blocks (tool_use / tool_result arrays) for the
 * backend's own context continuity. Rendering those would show the athlete
 * internal machinery, so anything that isn't a plain string is dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadInitialMessages, CHAT_ID_STORAGE_KEY as CHAT_ID_KEY } from './chat-runtime';

function mockFetch(response: { ok: boolean; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok,
      json: () => Promise.resolve(response.body ?? {}),
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadInitialMessages', () => {
  it('short-circuits without fetching when no chat id is stored', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await loadInitialMessages()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the plain-text user and assistant turns in order', async () => {
    localStorage.setItem(CHAT_ID_KEY, 'chat-1');
    mockFetch({
      ok: true,
      body: {
        messages: [
          { role: 'user', content: 'How was my week?' },
          { role: 'assistant', content: 'Strong — 320 TSS.' },
        ],
      },
    });

    expect(await loadInitialMessages()).toEqual([
      { role: 'user', content: 'How was my week?' },
      { role: 'assistant', content: 'Strong — 320 TSS.' },
    ]);
  });

  it('drops tool_use and tool_result rows rather than rendering them', async () => {
    localStorage.setItem(CHAT_ID_KEY, 'chat-1');
    mockFetch({
      ok: true,
      body: {
        messages: [
          { role: 'user', content: 'How was my week?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_training_data' }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '...' }] },
          { role: 'assistant', content: 'Strong — 320 TSS.' },
        ],
      },
    });

    const messages = await loadInitialMessages();
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => typeof m.content === 'string')).toBe(true);
  });

  it('drops rows with roles the thread cannot render', async () => {
    localStorage.setItem(CHAT_ID_KEY, 'chat-1');
    mockFetch({
      ok: true,
      body: {
        messages: [
          { role: 'system', content: 'internal preamble' },
          { role: 'assistant', content: 'Visible.' },
        ],
      },
    });

    expect(await loadInitialMessages()).toEqual([{ role: 'assistant', content: 'Visible.' }]);
  });

  it('returns an empty thread on a non-ok response instead of throwing', async () => {
    localStorage.setItem(CHAT_ID_KEY, 'chat-1');
    mockFetch({ ok: false });

    expect(await loadInitialMessages()).toEqual([]);
  });

  it('returns an empty thread when the request fails outright', async () => {
    localStorage.setItem(CHAT_ID_KEY, 'chat-1');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    expect(await loadInitialMessages()).toEqual([]);
  });

  it('tolerates a response with no messages field', async () => {
    localStorage.setItem(CHAT_ID_KEY, 'chat-1');
    mockFetch({ ok: true, body: {} });

    expect(await loadInitialMessages()).toEqual([]);
  });
});
