/**
 * arbitrateSpecialists runs only when the orchestrator dispatched >1
 * specialist in the same round (chat.stream.ts decides that, not this
 * module). Its own job is narrower: detect a real contradiction and phrase
 * why it matters — never decide which domain wins. These pin that split:
 * the priority resolution is a pure lookup, tested with zero model
 * involvement, and the model's output is only ever trusted for detection and
 * phrasing, never for the ranking itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '@anthropic-ai/sdk/resources/messages';

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));

vi.mock('../claude/claude.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude/claude.client.js')>();
  return { ...actual, chat: chatMock };
});

const { arbitrateSpecialists } = await import('./arbitrate-specialists.js');
const { higherPrioritySpecialist } = await import('../claude/model-config.js');

function detectorSaid(contradictions: unknown[]): Message {
  return {
    content: [{ type: 'tool_use', id: 'tu_1', name: 'detect_contradictions', input: { contradictions } }],
    stop_reason: 'tool_use',
  } as unknown as Message;
}

const CONSULTS = [
  { specialist: 'nutritionist' as const, response: 'Take creatine right after the ride, with your recovery meal.' },
  { specialist: 'strength_conditioning' as const, response: 'Take creatine any time of day — timing does not matter, just be consistent.' },
];

beforeEach(() => {
  chatMock.mockReset();
});

describe('higherPrioritySpecialist — the priority hierarchy itself', () => {
  it('ranks recovery above every other domain', () => {
    expect(higherPrioritySpecialist('recovery', 'cycling_coach')).toBe('recovery');
    expect(higherPrioritySpecialist('nutritionist', 'recovery')).toBe('recovery');
    expect(higherPrioritySpecialist('recovery', 'strength_conditioning')).toBe('recovery');
  });

  it('ranks cycling_coach above the two optimization domains', () => {
    expect(higherPrioritySpecialist('cycling_coach', 'nutritionist')).toBe('cycling_coach');
    expect(higherPrioritySpecialist('strength_conditioning', 'cycling_coach')).toBe('cycling_coach');
  });

  it('is order-independent — the higher tier wins regardless of argument order', () => {
    expect(higherPrioritySpecialist('cycling_coach', 'recovery')).toBe('recovery');
    expect(higherPrioritySpecialist('recovery', 'cycling_coach')).toBe('recovery');
  });

  it('returns null on a genuine tie — nutritionist and strength_conditioning are equal priority', () => {
    // Regression case: this used to resolve to `a`, which is arbitrary
    // (whichever order the arbitration classifier happened to name the
    // domains in) — a recorded eval fixture caught the classifier's own
    // `reason` text arguing for the domain that *didn't* win. Returning
    // null is what stops a fake winner from being manufactured.
    expect(higherPrioritySpecialist('nutritionist', 'strength_conditioning')).toBeNull();
    expect(higherPrioritySpecialist('strength_conditioning', 'nutritionist')).toBeNull();
  });
});

describe('arbitrateSpecialists', () => {
  it('resolves a tier-mismatched contradiction via the hard-coded tier, not whatever the model said', async () => {
    chatMock.mockResolvedValue(
      detectorSaid([
        {
          domain_a: 'strength_conditioning',
          domain_b: 'recovery',
          issue: 'Load recommendation conflicts with a recovery flag.',
          reason: 'Recovery takes priority here given the overreach signal.',
        },
      ]),
    );

    const resolved = await arbitrateSpecialists(CONSULTS);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].chosenDomain).toBe('recovery');
    expect(resolved[0].domainA).toBe('strength_conditioning');
    expect(resolved[0].domainB).toBe('recovery');
    expect(resolved[0].reason).toContain('Recovery takes priority');
  });

  it('leaves chosenDomain null on a genuine tie, without discarding the contradiction', async () => {
    chatMock.mockResolvedValue(
      detectorSaid([
        {
          domain_a: 'strength_conditioning',
          domain_b: 'nutritionist',
          issue: 'Timing advice for creatine conflicts.',
          reason: 'These two domains are equal priority — no fixed winner, worth weighing yourself.',
        },
      ]),
    );

    const resolved = await arbitrateSpecialists(CONSULTS);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].chosenDomain).toBeNull();
    expect(resolved[0].domainA).toBe('strength_conditioning');
    expect(resolved[0].domainB).toBe('nutritionist');
  });

  it('lets recovery win over an optimization domain regardless of the order the model names them', async () => {
    chatMock.mockResolvedValue(
      detectorSaid([
        { domain_a: 'nutritionist', domain_b: 'recovery', issue: 'x', reason: 'y' },
      ]),
    );

    const resolved = await arbitrateSpecialists([
      { specialist: 'nutritionist', response: 'Eat in a deficit today.' },
      { specialist: 'recovery', response: 'You are overreached — eat at maintenance today.' },
    ]);

    expect(resolved[0].chosenDomain).toBe('recovery');
  });

  it('returns an empty array when nothing contradicted', async () => {
    chatMock.mockResolvedValue(detectorSaid([]));

    expect(await arbitrateSpecialists(CONSULTS)).toEqual([]);
  });

  it('drops a contradiction naming an unknown or degenerate domain pair rather than throwing', async () => {
    chatMock.mockResolvedValue(
      detectorSaid([
        { domain_a: 'astrologer', domain_b: 'nutritionist', issue: 'x', reason: 'y' },
        { domain_a: 'recovery', domain_b: 'recovery', issue: 'x', reason: 'y' },
      ]),
    );

    expect(await arbitrateSpecialists(CONSULTS)).toEqual([]);
  });

  it('fails open (empty array) when the API call itself errors', async () => {
    chatMock.mockRejectedValue(new Error('rate limited'));

    expect(await arbitrateSpecialists(CONSULTS)).toEqual([]);
  });

  it('fails open when the classifier returns an unusable shape', async () => {
    chatMock.mockResolvedValue({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'detect_contradictions', input: { contradictions: 'not an array' } }],
      stop_reason: 'tool_use',
    } as unknown as Message);

    expect(await arbitrateSpecialists(CONSULTS)).toEqual([]);
  });

  it('fails open when the model returns no tool call at all', async () => {
    chatMock.mockResolvedValue({ content: [{ type: 'text', text: 'no thanks' }], stop_reason: 'end_turn' } as unknown as Message);

    expect(await arbitrateSpecialists(CONSULTS)).toEqual([]);
  });
});
