// @vitest-environment jsdom
/**
 * loadInitialMessages restores a previous conversation from the BFF.
 *
 * The filtering is the part worth pinning: turns that involved tools also
 * persist raw Anthropic content blocks (tool_use / tool_result arrays) for the
 * backend's own context continuity. Rendering those would show the athlete
 * internal machinery, so most of it is dropped — with one exception:
 * consult_specialist is reconstructed into its own speaker-tagged message
 * (a real, separate top-level message — same as the live stream produces),
 * so a specialist's answer survives a page refresh instead of vanishing along
 * with the rest of that round's tool noise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ThreadMessageLike } from '@assistant-ui/react';
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

/** Matches orchestratorMessage()'s shape in chat-runtime.ts, for asserting against without repeating the metadata/status boilerplate everywhere. */
function orchestratorMsg(content: string): ThreadMessageLike {
  return {
    role: 'assistant',
    content,
    status: { type: 'complete', reason: 'unknown' },
    metadata: { custom: { speaker: 'orchestrator' } },
  };
}

/** Matches specialistMessage()'s shape in chat-runtime.ts. */
function specialistMsg(specialist: string, text: string): ThreadMessageLike {
  return {
    role: 'assistant',
    content: text,
    status: { type: 'complete', reason: 'unknown' },
    metadata: { custom: { speaker: specialist } },
  };
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

  it('returns the plain-text user and assistant turns in order, tagged as the orchestrator', async () => {
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
      orchestratorMsg('Strong — 320 TSS.'),
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

  it('reconstructs a consult_specialist round into its own speaker-tagged message', async () => {
    localStorage.setItem(CHAT_ID_KEY, 'chat-1');
    mockFetch({
      ok: true,
      body: {
        messages: [
          { role: 'user', content: 'How is my recovery?' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'consult_specialist', input: { specialist: 'recovery' } }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: JSON.stringify({ ok: true, specialist: 'recovery', response: 'Take two easy days.' }),
              },
            ],
          },
          { role: 'assistant', content: 'Rest up this week.' },
        ],
      },
    });

    const messages = await loadInitialMessages();
    expect(messages).toEqual([
      { role: 'user', content: 'How is my recovery?' },
      specialistMsg('recovery', 'Take two easy days.'),
      orchestratorMsg('Rest up this week.'),
    ]);
  });

  it('keeps the orchestrator\'s own prose from the same round as a separate message ahead of the specialist reply', async () => {
    localStorage.setItem(CHAT_ID_KEY, 'chat-1');
    mockFetch({
      ok: true,
      body: {
        messages: [
          { role: 'user', content: 'How is my recovery?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check with the recovery specialist.' },
              { type: 'tool_use', id: 't1', name: 'consult_specialist', input: { specialist: 'recovery' } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: JSON.stringify({ ok: true, specialist: 'recovery', response: 'Take two easy days.' }),
              },
            ],
          },
        ],
      },
    });

    const messages = await loadInitialMessages();
    expect(messages).toEqual([
      { role: 'user', content: 'How is my recovery?' },
      orchestratorMsg('Let me check with the recovery specialist.'),
      specialistMsg('recovery', 'Take two easy days.'),
    ]);
  });

  it('drops a consult_specialist round that failed rather than showing a broken message', async () => {
    localStorage.setItem(CHAT_ID_KEY, 'chat-1');
    mockFetch({
      ok: true,
      body: {
        messages: [
          { role: 'user', content: 'How is my recovery?' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'consult_specialist', input: { specialist: 'recovery' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":false,"error":"empty response"}', is_error: true }],
          },
          { role: 'assistant', content: 'Something went wrong — try again.' },
        ],
      },
    });

    const messages = await loadInitialMessages();
    expect(messages).toEqual([
      { role: 'user', content: 'How is my recovery?' },
      orchestratorMsg('Something went wrong — try again.'),
    ]);
  });

  it('still drops a non-specialist tool round entirely, even alongside a specialist round', async () => {
    localStorage.setItem(CHAT_ID_KEY, 'chat-1');
    mockFetch({
      ok: true,
      body: {
        messages: [
          { role: 'user', content: 'Plan my week.' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_athlete_context' }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't2', name: 'consult_specialist', input: { specialist: 'cycling_coach' } }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't2',
                content: JSON.stringify({ ok: true, specialist: 'cycling_coach', response: 'Add a threshold block.' }),
              },
            ],
          },
        ],
      },
    });

    const messages = await loadInitialMessages();
    expect(messages).toEqual([
      { role: 'user', content: 'Plan my week.' },
      specialistMsg('cycling_coach', 'Add a threshold block.'),
    ]);
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

    expect(await loadInitialMessages()).toEqual([orchestratorMsg('Visible.')]);
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
