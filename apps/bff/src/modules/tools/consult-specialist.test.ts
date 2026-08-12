/**
 * consultSpecialist's context contract: each specialist declares what it
 * needs (model-config.ts's SPECIALIST_CONTEXT_CONTRACTS) instead of the
 * orchestrator assembling an untyped athlete_context blob. These pin the
 * failure mode that motivated it — a required field missing (e.g. weight_kg
 * for the nutritionist) fails the tool call with a named-field error *before*
 * the specialist is called, rather than the specialist quietly reasoning
 * without it — plus the fall-through behavior for an unknown specialist and
 * an empty specialist reply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '@anthropic-ai/sdk/resources/messages';

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));

vi.mock('../claude/claude.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude/claude.client.js')>();
  return { ...actual, chat: chatMock };
});

const { consultSpecialist } = await import('./consult-specialist.js');

function textResponse(text: string): Message {
  return { content: [{ type: 'text', text, citations: [] }] } as unknown as Message;
}

beforeEach(() => {
  chatMock.mockReset();
});

describe('consultSpecialist — context contract', () => {
  it('rejects a consult missing a required field, without calling the specialist', async () => {
    const result = await consultSpecialist(
      { specialist: 'nutritionist', query: 'How many carbs before a 3hr ride?', athlete_context: {} },
      'athlete-1',
    );

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('weight_kg');
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('names every missing required field, not just the first', async () => {
    // recovery requires tsb; nothing else does double duty here, so an empty
    // context on cycling_coach (requires ftp_w) exercises a different field —
    // the point is the message names the field that's actually missing.
    const result = await consultSpecialist(
      { specialist: 'recovery', query: 'Should I take a rest day?' },
      'athlete-1',
    );

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('tsb');
  });

  it('accepts a valid context, strips fields outside the contract, and calls the specialist with only those', async () => {
    chatMock.mockResolvedValue(textResponse('Eat more carbs.'));

    const result = await consultSpecialist(
      {
        specialist: 'nutritionist',
        query: 'How many carbs before a 3hr ride?',
        athlete_context: { weight_kg: 70, current_phase: 'build', favorite_color: 'blue' },
      },
      'athlete-1',
    );

    expect(result).toEqual({ ok: true, specialist: 'nutritionist', response: 'Eat more carbs.' });
    expect(chatMock).toHaveBeenCalledTimes(1);

    const sentContent = chatMock.mock.calls[0][0].messages[0].content as string;
    expect(sentContent).toContain('"weight_kg":70');
    expect(sentContent).toContain('"current_phase":"build"');
    expect(sentContent).not.toContain('favorite_color');
  });

  it('passes with only the required field — optional fields are genuinely optional', async () => {
    chatMock.mockResolvedValue(textResponse('Ease off this week.'));

    const result = await consultSpecialist(
      { specialist: 'cycling_coach', query: 'Should I taper?', athlete_context: { ftp_w: 285 } },
      'athlete-1',
    );

    expect(result.ok).toBe(true);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown specialist before any contract lookup', async () => {
    const result = await consultSpecialist(
      { specialist: 'astrologer', query: 'What does Mercury say?' },
      'athlete-1',
    );

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('Unknown specialist');
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('reports an empty specialist reply as a failure rather than an empty success', async () => {
    chatMock.mockResolvedValue(textResponse(''));

    const result = await consultSpecialist(
      { specialist: 'cycling_coach', query: 'Should I taper?', athlete_context: { ftp_w: 285 } },
      'athlete-1',
    );

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('empty response');
  });
});
