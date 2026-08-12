/**
 * Replays a taped real orchestrator run for a genuinely new, blank-seeded
 * athlete (no weight anywhere — not the athletes.weight_kg column, not
 * coaching notes) asked a nutrition question that needs it. See
 * eval-race-readiness.test.ts for why this pattern exists.
 *
 * This fixture set out to catch consult_specialist's validation-error retry
 * loop in a real trace. It never fires: across five real recordings, the
 * orchestrator always checks get_athlete_context/get_body_metrics first,
 * confirms weight is missing, and asks the athlete directly rather than
 * attempting a consult it can already tell (from consult_specialist's own
 * tool description — describeSpecialistContracts()) would fail. See
 * fixtures/nutrition-missing-weight.json's `_provenance` for the full story.
 * The validation error itself is still covered, deterministically, by
 * consult-specialist.test.ts; this fixture instead pins the real, observed,
 * and arguably better behavior — ask, don't guess, don't attempt a doomed call.
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

describe('golden trace: nutrition-missing-weight', () => {
  const fixture = loadFixture('nutrition-missing-weight');
  const cassette = loadCassette('nutrition-missing-weight');

  it('the recorded cassette matches the golden trace', () => {
    const result = scoreTrace(fixture, cassette);
    expect(result.pass, JSON.stringify(result, null, 2)).toBe(true);
  });

  it('replaying the tape through the real orchestration loop reproduces the same trace', async () => {
    for (const round of cassette.rounds) {
      chatStreamMock.mockReturnValueOnce(fakeStreamFromRound(round));
    }
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

    // The regression this fixture actually guards: never call consult_specialist
    // for this athlete/question without the required field, and never fabricate
    // a weight to save via update_athlete_profile just to end the conversation.
    expect(dispatched.some((c) => c.name === 'consult_specialist')).toBe(false);
    expect(dispatched.some((c) => c.name === 'update_athlete_profile')).toBe(false);
  });
});
