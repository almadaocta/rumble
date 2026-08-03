import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import { chat } from '../claude/claude.client.js';
import { z } from 'zod';
import { logWeight, type LogWeightSuccess } from '../tools/log-weight.js';
import { createLogger, describeError } from '../../logger.js';

const log = createLogger('fast-path-weight');

// Weight logging is pure extraction (text → kg), not coaching judgment.
// One cheap Haiku call classifies AND extracts in a single forced tool call.
// Any failure falls through to the full orchestrator.
const CLASSIFY_AND_EXTRACT_TOOL = {
  name: 'classify_weight_log',
  description:
    'Classify whether the message is ONLY reporting a body weight measurement, with nothing else ' +
    'requiring a coaching response (no questions, no other requests). Be conservative — if in doubt, ' +
    'is_weight_log is false. If true, extract the weight fields.',
  input_schema: {
    type: 'object' as const,
    properties: {
      is_weight_log: {
        type: 'boolean',
        description: 'True only if the entire message is just reporting a body weight, nothing else.',
      },
      weight_kg: {
        type: 'number',
        description: 'Body weight in kilograms.',
      },
      date: {
        type: 'string',
        description: 'ISO date YYYY-MM-DD if a specific past date is mentioned. Omit for today.',
      },
      note: {
        type: 'string',
        description: 'Optional context, e.g. "morning", "post-race".',
      },
    },
    required: ['is_weight_log'],
  },
};

const ClassifyResult = z
  .object({
    is_weight_log: z.boolean(),
    weight_kg: z.number().positive().optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    note: z.string().optional(),
  })
  .catchall(z.unknown());

function formatConfirmation(result: LogWeightSuccess): string {
  let text = `Logged: ${result.weight_kg} kg`;
  if (result.note) text += ` (${result.note})`;
  text += ` on ${result.date}.`;
  return text;
}

export type WeightFastPathResult =
  | { handled: false }
  | { handled: true; confirmationText: string };

export async function tryWeightFastPath(
  userText: string,
  athleteId: string,
): Promise<WeightFastPathResult> {
  let decision;
  try {
    decision = await chat({
      model: 'claude-haiku-4-5',
      system: 'You classify and extract body weight logs for a cycling coach app.',
      messages: [{ role: 'user', content: userText }],
      tools: [CLASSIFY_AND_EXTRACT_TOOL],
      toolChoice: { name: 'classify_weight_log' },
      maxTokens: 256,
    });
  } catch (err) {
    log.warn('weight classifier failed, falling back to orchestrator', describeError(err));
    return { handled: false };
  }

  const toolUse = decision.content.find((b): b is ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) return { handled: false };

  const parsed = ClassifyResult.safeParse(toolUse.input);
  if (!parsed.success) {
    log.warn('weight classifier returned an unusable shape, falling back to orchestrator', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
    return { handled: false };
  }

  const args = parsed.data;
  if (!args.is_weight_log || args.weight_kg == null) return { handled: false };

  let outcome;
  try {
    outcome = await logWeight(
      {
        weight_kg: args.weight_kg,
        date: args.date,
        note: args.note,
      },
      athleteId,
    );
  } catch (err) {
    log.error('logWeight failed, falling back to orchestrator', describeError(err));
    return { handled: false };
  }

  if (!outcome.ok) {
    log.warn('logWeight declined, falling back to orchestrator', { error: outcome.error });
    return { handled: false };
  }

  return { handled: true, confirmationText: formatConfirmation(outcome) };
}
