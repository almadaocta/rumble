/**
 * Replays a taped real orchestrator run (see record-tape.ts) and scores it
 * against the golden trace fixture — CI-safe (no live API call, no cost,
 * deterministic) via the same chatStream-mocking seam chat.stream.test.ts
 * already uses.
 *
 * Two layers, deliberately: scoring the cassette directly pins "this real,
 * once-observed run picked the right tools." Replaying it through the real
 * pipeStreamWithToolExecution additionally pins "the harness correctly
 * drives this real trace" (round budget, message assembly, tool dispatch)
 * — a regression in the loop itself, not the model, would show up here.
 *
 * Neither layer can catch the model getting worse, or an orchestrator.md
 * edit changing behavior — the response is frozen at record time. That's
 * why re-taping (running record-tape.ts against the live API) is a manual
 * step, not something this file or CI does automatically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Response as ExpressResponse } from 'express';
import type { Message } from '@anthropic-ai/sdk/resources/messages';
import { scoreTrace, type Fixture, type Cassette } from './score-trace.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const { chatStreamMock } = vi.hoisted(() => ({ chatStreamMock: vi.fn() }));
const { executeToolCallsMock } = vi.hoisted(() => ({ executeToolCallsMock: vi.fn() }));
const { arbitrateSpecialistsMock } = vi.hoisted(() => ({ arbitrateSpecialistsMock: vi.fn() }));

vi.mock('../modules/claude/claude.client.js', () => ({ chatStream: chatStreamMock }));
vi.mock('../modules/tools/tool.executor.js', () => ({
  executeToolCalls: executeToolCallsMock,
  ORCHESTRATOR_TOOLS: [],
}));
vi.mock('../modules/tools/arbitrate-specialists.js', () => ({ arbitrateSpecialists: arbitrateSpecialistsMock }));

const { pipeStreamWithToolExecution } = await import('../modules/chat/chat.stream.js');

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', `${name}.json`), 'utf-8')) as Fixture;
}

function loadCassette(name: string): Cassette {
  return JSON.parse(readFileSync(join(HERE, 'cassettes', `${name}.json`), 'utf-8')) as Cassette;
}

/** Turns one taped round into the shape chat.stream.ts's real code expects back from chatStream(). */
function fakeStreamFromRound(round: Cassette['rounds'][number]) {
  return {
    on: vi.fn((event: string, cb: (delta: string) => void) => {
      if (event === 'text') for (const delta of round.textDeltas ?? []) cb(delta);
    }),
    finalMessage: vi
      .fn()
      .mockResolvedValue({ content: round.content, stop_reason: round.stop_reason } as unknown as Message),
  };
}

function createMockRes(): ExpressResponse {
  return { headersSent: false, setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn() } as unknown as ExpressResponse;
}

beforeEach(() => {
  chatStreamMock.mockReset();
  executeToolCallsMock.mockReset();
  arbitrateSpecialistsMock.mockReset();
  arbitrateSpecialistsMock.mockResolvedValue([]);
});

describe('golden trace: race-readiness', () => {
  const fixture = loadFixture('race-readiness');
  const cassette = loadCassette('race-readiness');

  it('the recorded cassette matches the golden trace', () => {
    const result = scoreTrace(fixture, cassette);
    expect(result.pass, JSON.stringify(result, null, 2)).toBe(true);
  });

  it('replaying the tape through the real orchestration loop reproduces the same trace', async () => {
    for (const round of cassette.rounds) {
      chatStreamMock.mockReturnValueOnce(fakeStreamFromRound(round));
    }
    // Real tool *output* doesn't matter for a tool-selection eval — only
    // that the loop advances exactly as many times as the tape did, with
    // the same calls dispatched. A stub success lets the round loop
    // progress without needing the recording DB copy present in CI.
    executeToolCallsMock.mockImplementation(
      async (calls: Array<{ id: string; name: string }>) =>
        calls.map((c) => ({ tool_call_id: c.id, name: c.name, result: { ok: true } })),
    );

    await pipeStreamWithToolExecution(createMockRes(), {
      athleteId: cassette.athleteId,
      chatId: 'eval-replay',
      contextPreamble: '',
      messages: [{ role: 'user', content: fixture.prompt }],
    });

    const dispatched = executeToolCallsMock.mock.calls.flatMap(
      (call) => call[0] as Array<{ name: string; arguments: Record<string, unknown> }>,
    );
    const harnessTrace: Cassette = {
      ...cassette,
      rounds: [
        {
          content: dispatched.map((c, i) => ({ type: 'tool_use', id: `replay-${i}`, name: c.name, input: c.arguments })),
          stop_reason: 'tool_use',
        },
      ],
    };

    const result = scoreTrace(fixture, harnessTrace);
    expect(result.pass, JSON.stringify(result, null, 2)).toBe(true);
  });
});
