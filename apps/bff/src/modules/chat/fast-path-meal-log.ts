import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import { chat } from '../claude/claude.client.js';
import { z } from 'zod';
import { logMeal, type LogMealSuccess } from '../tools/log-meal.js';
import { MEAL_TYPES, CONFIDENCE_TIERS } from '../tools/vocabularies.js';
import { createLogger, describeError } from '../../logger.js';

const log = createLogger('fast-path');

// Meal logging is structured extraction (text → calories/macros), not
// judgment — it never needed the Opus orchestrator's tool-routing reasoning,
// let alone two full Opus calls (decide, then synthesize a reply). One cheap
// Haiku call classifies AND extracts in a single forced tool call; if it's
// not purely a meal log, we fall through to the normal orchestrator path.
const CLASSIFY_AND_EXTRACT_TOOL = {
  name: 'classify_meal_log',
  description:
    'Classify whether the message is ONLY reporting food/drink already consumed, with nothing else in it requiring a coaching response (no questions, no other requests, no context needed from prior conversation). Be conservative — if in doubt, is_meal_log is false. If true, extract the meal log fields.',
  input_schema: {
    type: 'object' as const,
    properties: {
      is_meal_log: {
        type: 'boolean',
        description: 'True only if the entire message is just reporting food/drink eaten, nothing else.',
      },
      meal_type: {
        type: 'string',
        enum: [...MEAL_TYPES],
      },
      description: { type: 'string', description: 'What the athlete ate, as described' },
      calories: { type: 'number' },
      carbs_g: { type: 'number' },
      protein_g: { type: 'number' },
      fat_g: { type: 'number' },
      confidence_tier: {
        type: 'number',
        enum: [...CONFIDENCE_TIERS],
        description: '1=weighed/label, 2=photo, 3=description-based estimate',
      },
    },
    required: ['is_meal_log'],
  },
};

/**
 * What the classifier is expected to hand back.
 *
 * Parsed, not asserted. This value arrives from a model, which makes it the one
 * place in this app where the shape is a hope rather than a guarantee — a cast
 * here lets a bad shape travel on to logMeal, whose parse then fails and gets
 * reported as "logMeal failed" at error level for what is really the classifier
 * misbehaving.
 *
 * `.catchall(z.unknown())` because the model sometimes volunteers extra fields
 * and none of them are a reason to abandon the fast path.
 */
const ClassifyResult = z
  .object({
    is_meal_log: z.boolean(),
    meal_type: z.enum(MEAL_TYPES).optional(),
    description: z.string().min(1).optional(),
    calories: z.number().optional(),
    carbs_g: z.number().optional(),
    protein_g: z.number().optional(),
    fat_g: z.number().optional(),
    // Checked against the real set here rather than left for logMeal to throw
    // on: the fall-through is the same either way, but this reports it as the
    // classifier misbehaving, which is what it is.
    confidence_tier: z
      .number()
      .int()
      .refine((n) => (CONFIDENCE_TIERS as readonly number[]).includes(n), {
        message: `must be one of: ${CONFIDENCE_TIERS.join(', ')}`,
      })
      .optional(),
  })
  .catchall(z.unknown());

function formatConfirmation(result: LogMealSuccess): string {
  const parts = [
    result.macros.calories != null && `${result.macros.calories} kcal`,
    result.macros.carbs_g != null && `${result.macros.carbs_g}g carbs`,
    result.macros.protein_g != null && `${result.macros.protein_g}g protein`,
    result.macros.fat_g != null && `${result.macros.fat_g}g fat`,
  ].filter(Boolean);
  let text = `Logged: ${result.description}`;
  if (parts.length > 0) text += ` — ${parts.join(', ')}`;
  text += '.';
  if (result.note) text += ` ${result.note}`;
  return text;
}

/**
 * Discriminated union rather than `handled: boolean` + optional text: the
 * confirmation exists only when the fast path handled the message, and encoding
 * that in the type is what saves the controller a non-null assertion at the seam.
 */
export type MealLogFastPathResult =
  | { handled: false }
  | { handled: true; confirmationText: string };

export async function tryMealLogFastPath(
  userText: string,
  athleteId: string,
): Promise<MealLogFastPathResult> {
  // The module's whole policy is "if anything is off, fall back to the full
  // orchestrator rather than failing the chat turn" — but only the logMeal call
  // below was guarded. An API error here (rate limit, overload, network) would
  // reject straight out of the fast path and take the athlete's message with it.
  let decision;
  try {
    decision = await chat({
      model: 'claude-haiku-4-5',
      system: 'You classify and extract nutrition logs for a cycling coach app.',
      messages: [{ role: 'user', content: userText }],
      tools: [CLASSIFY_AND_EXTRACT_TOOL],
      toolChoice: { name: 'classify_meal_log' },
      maxTokens: 512,
    });
  } catch (err) {
    log.warn('classifier failed, falling back to orchestrator', describeError(err));
    return { handled: false };
  }

  const toolUse = decision.content.find((b): b is ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) return { handled: false };

  const parsed = ClassifyResult.safeParse(toolUse.input);
  if (!parsed.success) {
    log.warn('classifier returned an unusable shape, falling back to orchestrator', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
    return { handled: false };
  }

  const args = parsed.data;
  if (!args.is_meal_log || !args.description) return { handled: false };

  // logMeal validates its args (zod) and throws on a bad shape — if the
  // classifier ever produces something slightly malformed, fall back to the
  // full orchestrator rather than failing the whole chat turn.
  let outcome;
  try {
    outcome = await logMeal(
      {
        meal_type: args.meal_type,
        description: args.description,
        calories: args.calories,
        carbs_g: args.carbs_g,
        protein_g: args.protein_g,
        fat_g: args.fat_g,
        confidence_tier: args.confidence_tier,
      },
      athleteId,
    );
  } catch (err) {
    log.error('logMeal failed, falling back to orchestrator', describeError(err));
    return { handled: false };
  }

  // logMeal now reports refusals through the shared `ok` envelope rather than
  // only by throwing, so a declined write falls back instead of being formatted
  // into a confirmation the athlete never earned.
  if (!outcome.ok) {
    log.warn('logMeal declined, falling back to orchestrator', { error: outcome.error });
    return { handled: false };
  }

  // No cast: logMeal declares `Promise<LogMealSuccess | ToolFailure>`, so the
  // `!outcome.ok` return above narrows this to LogMealSuccess on its own.
  return { handled: true, confirmationText: formatConfirmation(outcome) };
}
