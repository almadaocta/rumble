// Regression coverage for the agentic tool-call loop in pipeStreamWithToolExecution:
// the orchestrator can chain a second round of tool calls off the result of the
// first (e.g. consult_specialist, then act on that answer with another tool call)
// before it's forced to answer in prose. A single-fixed-round version of this loop
// would stop after round one no matter what the model asked for next — these tests
// pin the chaining behavior and the hard stop that guarantees termination.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response as ExpressResponse } from 'express';
import type { Message } from '@anthropic-ai/sdk/resources/messages';

const { chatStreamMock } = vi.hoisted(() => ({ chatStreamMock: vi.fn() }));
const { executeToolCallsMock } = vi.hoisted(() => ({ executeToolCallsMock: vi.fn() }));

vi.mock('../claude/claude.client.js', () => ({
  chatStream: chatStreamMock,
}));

vi.mock('../tools/tool.executor.js', () => ({
  executeToolCalls: executeToolCallsMock,
  ORCHESTRATOR_TOOLS: [],
}));

const { pipeStreamWithToolExecution, MAX_TOOL_ROUNDS } = await import('./chat.stream.js');

// pipeStreamWithToolExecution builds its "final answer" text from the
// live `stream.on('text', ...)` deltas, not from decision.content — so the
// fake stream must actually emit through `on` the same way the real
// MessageStream does, or the accumulated text comes back empty.
function fakeStream(decision: Partial<Message> & Pick<Message, 'content' | 'stop_reason'>, textDeltas: string[] = []) {
  return {
    on: vi.fn((event: string, cb: (delta: string) => void) => {
      if (event === 'text') for (const delta of textDeltas) cb(delta);
    }),
    finalMessage: vi.fn().mockResolvedValue(decision as Message),
  };
}

function textDecision(text: string): ReturnType<typeof fakeStream> {
  return fakeStream({ content: [{ type: 'text', text, citations: [] }], stop_reason: 'end_turn' }, [text]);
}

function toolDecision(id: string, name: string, input: Record<string, unknown>): ReturnType<typeof fakeStream> {
  return fakeStream({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
}

function createMockRes(): ExpressResponse {
  return {
    headersSent: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
  } as unknown as ExpressResponse;
}

const baseCtx = {
  athleteId: 'athlete-1',
  chatId: 'chat-1',
  contextPreamble: 'preamble',
  messages: [{ role: 'user' as const, content: 'plan me a week and adjust it for my last ride' }],
};

beforeEach(() => {
  chatStreamMock.mockReset();
  executeToolCallsMock.mockReset();
});

describe('pipeStreamWithToolExecution — multi-round tool calls', () => {
  it('lets the orchestrator act on the first tool result with a second tool call before answering', async () => {
    chatStreamMock
      .mockReturnValueOnce(toolDecision('t1', 'consult_specialist', { specialist: 'cycling_coach', query: 'q' }))
      .mockReturnValueOnce(toolDecision('t2', 'update_training_plan', { action: 'create' }))
      .mockReturnValueOnce(textDecision('Plan updated based on the specialist consult.'));

    executeToolCallsMock
      .mockResolvedValueOnce([{ tool_call_id: 't1', name: 'consult_specialist', result: { ok: true, response: 'do interval work' } }])
      .mockResolvedValueOnce([{ tool_call_id: 't2', name: 'update_training_plan', result: { ok: true } }]);

    const res = createMockRes();
    const produced = await pipeStreamWithToolExecution(res, baseCtx);

    expect(chatStreamMock).toHaveBeenCalledTimes(3);
    expect(executeToolCallsMock).toHaveBeenCalledTimes(2);
    expect(executeToolCallsMock.mock.calls[1][0]).toEqual([
      { id: 't2', name: 'update_training_plan', arguments: { action: 'create' } },
    ]);

    // 2 rounds × (assistant tool_use + tool_result) + final assistant answer
    expect(produced).toHaveLength(5);
    expect(produced.at(-1)).toEqual({ role: 'assistant', content: 'Plan updated based on the specialist consult.' });
  });

  it('answers directly with zero tool calls when none are needed', async () => {
    chatStreamMock.mockReturnValueOnce(textDecision('You had a solid week.'));

    const res = createMockRes();
    const produced = await pipeStreamWithToolExecution(res, baseCtx);

    expect(chatStreamMock).toHaveBeenCalledTimes(1);
    expect(executeToolCallsMock).not.toHaveBeenCalled();
    expect(produced).toEqual([{ role: 'assistant', content: 'You had a solid week.' }]);
  });

  it('never calls the model more than MAX_TOOL_ROUNDS times, even if it keeps requesting tools', async () => {
    // A model that (contrary to the contract) keeps emitting tool_use even on
    // the final round, which is called with no tools attached — this must not
    // be able to loop forever.
    chatStreamMock.mockImplementation(() => toolDecision('t', 'get_athlete_context', {}));
    executeToolCallsMock.mockResolvedValue([{ tool_call_id: 't', name: 'get_athlete_context', result: {} }]);

    const res = createMockRes();
    await pipeStreamWithToolExecution(res, baseCtx);

    // Against the exported bound, not a hardcoded 4: retuning MAX_TOOL_ROUNDS
    // should not require editing this test, and the invariant being pinned is
    // "terminates at the configured bound", not "terminates at four".
    expect(chatStreamMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    // The final round is called with no tools attached.
    expect(chatStreamMock.mock.calls[MAX_TOOL_ROUNDS - 1][0].tools).toBeUndefined();
    // The unreachable-guard error is streamed to the client rather than hanging.
    const written = (res.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join('');
    expect(written).toContain('needed more steps than allowed');
  });
});
