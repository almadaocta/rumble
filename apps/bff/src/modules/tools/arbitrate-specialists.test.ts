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
});

describe('arbitrateSpecialists', () => {
  it('resolves a detected contradiction via the hard-coded tier, not whatever the model said', async () => {
    chatMock.mockResolvedValue(
      detectorSaid([
        {
          domain_a: 'strength_conditioning',
          domain_b: 'nutritionist',
          issue: 'Timing advice for creatine conflicts.',
          reason: 'Consistency matters more than timing, so the flexible answer applies.',
        },
      ]),
    );

    const resolved = await arbitrateSpecialists(CONSULTS);

    expect(resolved).toHaveLength(1);
    // Neither domain here outranks the other (both tier 3) — higherPrioritySpecialist
    // resolves ties to its first argument, so the module's own domain_a/domain_b order
    // (as returned by the model) is what determines it, not a coin flip.
    expect(resolved[0].chosenDomain).toBe(
      higherPrioritySpecialist('strength_conditioning', 'nutritionist'),
    );
    expect(resolved[0].domainA).toBe('strength_conditioning');
    expect(resolved[0].domainB).toBe('nutritionist');
    expect(resolved[0].reason).toContain('Consistency');
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
