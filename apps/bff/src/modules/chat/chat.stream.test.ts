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

  it('marks the cache breakpoint on the last message, moved forward each round', async () => {
    // Round 1 has only the seed user turn. Round 2 adds the assistant
    // tool_use + tool_result from round 1's consult_specialist call — the
    // breakpoint must move onto that new last message, not stay on the
    // original user turn, or round 2 would resend round 1's tool exchange
    // uncached every time (the bug this test guards against).
    chatStreamMock
      .mockReturnValueOnce(toolDecision('t1', 'consult_specialist', { specialist: 'cycling_coach', query: 'q' }))
      .mockReturnValueOnce(textDecision('done'));
    executeToolCallsMock.mockResolvedValueOnce([
      { tool_call_id: 't1', name: 'consult_specialist', result: { ok: true, response: 'x' } },
    ]);

    const res = createMockRes();
    await pipeStreamWithToolExecution(res, baseCtx);

    expect(chatStreamMock).toHaveBeenCalledTimes(2);

    const round1Messages = chatStreamMock.mock.calls[0][0].messages;
    expect(round1Messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: baseCtx.messages[0].content, cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);

    const round2Messages = chatStreamMock.mock.calls[1][0].messages;
    expect(round2Messages).toHaveLength(3);
    // The original user turn is no longer marked — only one breakpoint exists
    // in the array at a time, so it never accumulates past the 4-per-request cap.
    expect(round2Messages[0].content).toBe(baseCtx.messages[0].content);
    const toolResultMsg = round2Messages[2];
    expect(toolResultMsg.role).toBe('user');
    expect(toolResultMsg.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('keeps tool schemas on the request but forbids tool use once round budget is exhausted', async () => {
    chatStreamMock.mockReturnValue(textDecision('answer'));
    const res = createMockRes();
    await pipeStreamWithToolExecution(res, baseCtx);

    const call = chatStreamMock.mock.calls[0][0];
    expect(call.tools).toBeDefined();
    expect(call.toolChoice).toBeUndefined();
  });

  it('emits a specialist-message frame with the full consult response, not just a preview', async () => {
    chatStreamMock
      .mockReturnValueOnce(toolDecision('t1', 'consult_specialist', { specialist: 'recovery', query: 'q' }))
      .mockReturnValueOnce(textDecision('Rest up.'));

    executeToolCallsMock.mockResolvedValueOnce([
      {
        tool_call_id: 't1',
        name: 'consult_specialist',
        result: { ok: true, specialist: 'recovery', response: 'Your TSB says take two easy days.' },
      },
    ]);

    const res = createMockRes();
    await pipeStreamWithToolExecution(res, baseCtx);

    const frames = (res.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('specialist-message'))
      .map((line) => JSON.parse(line.slice('data: '.length)));

    expect(frames).toEqual([
      { type: 'specialist-message', specialist: 'recovery', text: 'Your TSB says take two easy days.' },
    ]);
  });

  it('skips the specialist-message frame on a failed or malformed consult', async () => {
    chatStreamMock
      .mockReturnValueOnce(toolDecision('t1', 'consult_specialist', { specialist: 'recovery', query: 'q' }))
      .mockReturnValueOnce(textDecision('Something went wrong, try again.'));

    executeToolCallsMock.mockResolvedValueOnce([
      { tool_call_id: 't1', name: 'consult_specialist', result: null, error: 'Specialist returned empty response' },
    ]);

    const res = createMockRes();
    await pipeStreamWithToolExecution(res, baseCtx);

    const written = (res.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join('');
    expect(written).not.toContain('specialist-message');
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
    // the final round, which is called with tool_choice: none — this must not
    // be able to loop forever.
    chatStreamMock.mockImplementation(() => toolDecision('t', 'get_athlete_context', {}));
    executeToolCallsMock.mockResolvedValue([{ tool_call_id: 't', name: 'get_athlete_context', result: {} }]);

    const res = createMockRes();
    await pipeStreamWithToolExecution(res, baseCtx);

    // Against the exported bound, not a hardcoded 4: retuning MAX_TOOL_ROUNDS
    // should not require editing this test, and the invariant being pinned is
    // "terminates at the configured bound", not "terminates at four".
    expect(chatStreamMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    // The final round keeps the tool schemas (for cache-prefix stability) but
    // forbids tool use via tool_choice, instead of dropping `tools` entirely.
    const finalCall = chatStreamMock.mock.calls[MAX_TOOL_ROUNDS - 1][0];
    expect(finalCall.tools).toBeDefined();
    expect(finalCall.toolChoice).toEqual({ type: 'none' });
    // The unreachable-guard error is streamed to the client rather than hanging.
    const written = (res.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join('');
    expect(written).toContain('needed more steps than allowed');
  });
});
