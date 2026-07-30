/**
 * The fast path's contract is "if anything is off, fall back to the full
 * orchestrator rather than failing the chat turn".
 *
 * The classifier's output used to be double-cast (`input as unknown as
 * ClassifyArgs`) rather than parsed, so a malformed shape got as far as
 * logMeal's own zod parse — where the failure was reported as "logMeal failed",
 * at error level, for what is really the classifier misbehaving. These pin the
 * fall-through at each seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '@anthropic-ai/sdk/resources/messages';

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
const { logMealMock } = vi.hoisted(() => ({ logMealMock: vi.fn() }));

vi.mock('../claude/claude.client.js', () => ({ chat: chatMock }));

vi.mock('../tools/log-meal.js', async (importOriginal) => {
  // The vocabularies are real — the point of exporting them is that everything
  // uses the same list — but the handler is stubbed.
  const actual = await importOriginal<typeof import('../tools/log-meal.js')>();
  return { ...actual, logMeal: logMealMock };
});

const { tryMealLogFastPath } = await import('./fast-path-meal-log.js');

/** A Haiku response carrying one forced classify_meal_log tool call. */
function classifierSaid(input: unknown): Message {
  return {
    content: [{ type: 'tool_use', id: 'tu_1', name: 'classify_meal_log', input }],
    stop_reason: 'tool_use',
  } as unknown as Message;
}

const GOOD_LOG = {
  ok: true as const,
  id: 'n1',
  date: '2026-07-28',
  meal_type: 'lunch',
  description: 'chicken and rice',
  macros: { calories: 600, carbs_g: 70, protein_g: 45, fat_g: 12 },
  confidence_tier: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tryMealLogFastPath', () => {
  it('handles a clean meal log', async () => {
    chatMock.mockResolvedValue(
      classifierSaid({
        is_meal_log: true,
        description: 'chicken and rice',
        meal_type: 'lunch',
        calories: 600,
      }),
    );
    logMealMock.mockResolvedValue(GOOD_LOG);

    const result = await tryMealLogFastPath('had chicken and rice for lunch', 'athlete-1');

    expect(result.handled).toBe(true);
    expect(result).toHaveProperty('confirmationText', expect.stringContaining('chicken and rice'));
  });

  it('falls back when the classifier says it is not a meal log', async () => {
    chatMock.mockResolvedValue(classifierSaid({ is_meal_log: false }));

    expect(await tryMealLogFastPath('how was my week?', 'athlete-1')).toEqual({ handled: false });
    expect(logMealMock).not.toHaveBeenCalled();
  });

  it('falls back on a malformed classifier shape without calling logMeal', async () => {
    // is_meal_log as a string is exactly what the cast used to wave through:
    // truthy, so it reached logMeal and failed there instead of here.
    chatMock.mockResolvedValue(classifierSaid({ is_meal_log: 'yes', description: 'a banana' }));

    expect(await tryMealLogFastPath('a banana', 'athlete-1')).toEqual({ handled: false });
    expect(logMealMock).not.toHaveBeenCalled();
  });

  it('falls back on a meal_type outside the published vocabulary', async () => {
    chatMock.mockResolvedValue(
      classifierSaid({ is_meal_log: true, description: 'a banana', meal_type: 'brunch' }),
    );

    expect(await tryMealLogFastPath('a banana at brunch', 'athlete-1')).toEqual({ handled: false });
    expect(logMealMock).not.toHaveBeenCalled();
  });

  it('falls back on a confidence_tier outside 1-3', async () => {
    chatMock.mockResolvedValue(
      classifierSaid({ is_meal_log: true, description: 'a banana', confidence_tier: 7 }),
    );

    expect(await tryMealLogFastPath('a banana', 'athlete-1')).toEqual({ handled: false });
    expect(logMealMock).not.toHaveBeenCalled();
  });

  it('keeps extra fields the model volunteers from derailing the fast path', async () => {
    chatMock.mockResolvedValue(
      classifierSaid({ is_meal_log: true, description: 'a banana', reasoning: 'looks like food' }),
    );
    logMealMock.mockResolvedValue({ ...GOOD_LOG, description: 'a banana' });

    expect((await tryMealLogFastPath('a banana', 'athlete-1')).handled).toBe(true);
  });

  it('falls back when the classifier call itself fails', async () => {
    chatMock.mockRejectedValue(new Error('overloaded'));

    expect(await tryMealLogFastPath('a banana', 'athlete-1')).toEqual({ handled: false });
  });

  it('falls back when logMeal declines the write', async () => {
    chatMock.mockResolvedValue(classifierSaid({ is_meal_log: true, description: 'a banana' }));
    logMealMock.mockResolvedValue({ ok: false, error: 'nope' });

    expect(await tryMealLogFastPath('a banana', 'athlete-1')).toEqual({ handled: false });
  });
});
