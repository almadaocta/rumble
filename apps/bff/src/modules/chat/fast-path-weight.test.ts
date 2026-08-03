import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock before importing the module under test so the bindings are replaced
vi.mock('../claude/claude.client.js', () => ({
  chat: vi.fn(),
}));
vi.mock('../tools/log-weight.js', () => ({
  logWeight: vi.fn(),
}));

import { chat } from '../claude/claude.client.js';
import { logWeight } from '../tools/log-weight.js';
import { tryWeightFastPath } from './fast-path-weight.js';

const mockChat = vi.mocked(chat);
const mockLogWeight = vi.mocked(logWeight);

function makeClassifierResponse(input: Record<string, unknown>) {
  return {
    content: [{ type: 'tool_use' as const, id: 'x', name: 'classify_weight_log', input }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tryWeightFastPath', () => {
  it('returns handled:true and confirmation for a plain weight message', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: true, weight_kg: 74.5 }) as never,
    );
    mockLogWeight.mockResolvedValueOnce({
      ok: true,
      id: 'abc',
      date: '2026-08-03',
      weight_kg: 74.5,
    });

    const result = await tryWeightFastPath('I weigh 74.5 kg', 'athlete-1');

    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.confirmationText).toContain('74.5 kg');
    expect(result.confirmationText).toContain('2026-08-03');
  });

  it('returns handled:false when is_weight_log is false', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: false }) as never,
    );

    const result = await tryWeightFastPath('What should I eat before a race?', 'athlete-1');
    expect(result.handled).toBe(false);
    expect(mockLogWeight).not.toHaveBeenCalled();
  });

  it('returns handled:false when weight_kg is missing from classifier output', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: true }) as never,
    );

    const result = await tryWeightFastPath('I weighed in', 'athlete-1');
    expect(result.handled).toBe(false);
  });

  it('returns handled:false when the chat call throws', async () => {
    mockChat.mockRejectedValueOnce(new Error('rate limit'));

    const result = await tryWeightFastPath('I weigh 75 kg', 'athlete-1');
    expect(result.handled).toBe(false);
  });

  it('returns handled:false when no tool_use block is returned', async () => {
    mockChat.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] } as never);

    const result = await tryWeightFastPath('I weigh 75 kg', 'athlete-1');
    expect(result.handled).toBe(false);
  });

  it('returns handled:false when logWeight throws', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: true, weight_kg: 73.0 }) as never,
    );
    mockLogWeight.mockRejectedValueOnce(new Error('db error'));

    const result = await tryWeightFastPath('73 kg this morning', 'athlete-1');
    expect(result.handled).toBe(false);
  });

  it('returns handled:false when logWeight returns ok:false', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: true, weight_kg: 73.0 }) as never,
    );
    mockLogWeight.mockResolvedValueOnce({ ok: false, error: 'something wrong' });

    const result = await tryWeightFastPath('73 kg this morning', 'athlete-1');
    expect(result.handled).toBe(false);
  });

  it('includes the note in the confirmation text', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: true, weight_kg: 72.0, note: 'morning fasted' }) as never,
    );
    mockLogWeight.mockResolvedValueOnce({
      ok: true,
      id: 'def',
      date: '2026-08-03',
      weight_kg: 72.0,
      note: 'morning fasted',
    });

    const result = await tryWeightFastPath('72 kg this morning fasted', 'athlete-1');
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.confirmationText).toContain('morning fasted');
  });
});
