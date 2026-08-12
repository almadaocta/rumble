/**
 * Replays a taped real orchestrator run that actually triggers arbitration
 * end-to-end — two specialists consulted in one round, a genuine
 * contradiction detected, and (in this recording) a genuine tie between two
 * equal-priority domains (nutritionist vs strength_conditioning). See
 * eval-race-readiness.test.ts for why this pattern (score the cassette
 * directly, then replay it through the real loop) exists.
 *
 * This recording is *why* higherPrioritySpecialist returns `Specialist |
 * null` instead of defaulting ties to `a`: the first real run against the
 * pre-fix code produced a contradiction whose `reason` text argued for
 * strength_conditioning while the forced pick was nutritionist — a fake
 * winner with an incongruent justification. Re-recorded against the fix; see
 * fixtures/creatine-timing-arbitration.json's `_provenance` for the full story.
 *
 * What this cassette does NOT cover: the SSE contradiction-notice frame with
 * a real (non-null) chosenDomain — this recording happens to land on a tie,
 * which by design emits no notice card. That emission path is still
 * exercised, just by chat.stream.test.ts's mocked arbitration tests rather
 * than a second live recording — the payload-construction code is identical
 * either way, and chasing a live non-tie recording didn't seem worth the
 * additional API spend once the tie case had already caught the real bug.
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
});

describe('golden trace: creatine-timing-arbitration', () => {
  const fixture = loadFixture('creatine-timing-arbitration');
  const cassette = loadCassette('creatine-timing-arbitration');

  it('the recorded cassette matches the golden trace', () => {
    const result = scoreTrace(fixture, cassette);
    expect(result.pass, JSON.stringify(result, null, 2)).toBe(true);
  });

  it('the recording actually triggered arbitration, and it found the tie', () => {
    // Guards the fixture itself, not just the replay: if a future re-tape
    // stops triggering >1 specialist in one round, this fails loudly rather
    // than silently degrading into a fixture that no longer exercises
    // arbitration at all.
    expect(cassette.arbitration).toBeDefined();
    expect(cassette.arbitration).toHaveLength(1);
    expect(cassette.arbitration![0].chosenDomain).toBeNull();
    expect([cassette.arbitration![0].domainA, cassette.arbitration![0].domainB].sort()).toEqual(
      ['nutritionist', 'strength_conditioning'].sort(),
    );
  });

  it('replaying the tape drives real arbitration (via the recorded resolution) through the real loop', async () => {
    for (const round of cassette.rounds) {
      chatStreamMock.mockReturnValueOnce(fakeStreamFromRound(round));
    }
    executeToolCallsMock.mockImplementation(
      async (calls: Array<{ id: string; name: string }>) =>
        calls.map((c) => ({
          tool_call_id: c.id,
          name: c.name,
          // consult_specialist's result needs specialist+response so
          // chat.stream.ts's own consult-collection logic (which decides
          // whether to call arbitration at all) recognizes it as a real
          // specialist reply — a bare {ok:true} stub, fine for
          // race-readiness, would silently make this test not exercise the
          // arbitration trigger at all.
          result:
            c.name === 'consult_specialist'
              ? { ok: true, specialist: 'nutritionist', response: 'stubbed specialist reply' }
              : { ok: true },
        })),
    );
    // Replays the REAL recorded resolution — not mocked to [] or to a
    // hand-authored value — so this exercises arbitrateSpecialists' actual
    // recorded output through chat.stream.ts's real handling of it.
    arbitrateSpecialistsMock.mockResolvedValue(cassette.arbitration ?? []);

    const res = createMockRes();
    await pipeStreamWithToolExecution(res, {
      athleteId: cassette.athleteId,
      chatId: 'eval-replay',
      contextPreamble: '',
      messages: [{ role: 'user', content: fixture.prompt }],
    });

    expect(arbitrateSpecialistsMock).toHaveBeenCalled();

    // Tie (chosenDomain null) — no notice card, by design (see
    // chat.stream.ts). If this ever fires for a genuine tie, that's the
    // bug this fixture was built to catch, back.
    const written = (res.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join('');
    expect(written).not.toContain('contradiction-notice');

    // The internal note IS still injected — Opus needs to know a real
    // contradiction happened even without a card the athlete sees.
    const lastChatCall = chatStreamMock.mock.calls.at(-1)?.[0];
    const lastUserMessage = [...lastChatCall.messages].reverse().find((m: { role: string }) => m.role === 'user');
    const noteBlock = Array.isArray(lastUserMessage?.content)
      ? lastUserMessage.content.find((b: { type: string }) => b.type === 'text')
      : undefined;
    expect(noteBlock?.text).toContain('equal priority');
  });
});
