import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import { chat } from '../claude/claude.client.js';
import { isSpecialist, higherPrioritySpecialist, type Specialist } from '../claude/model-config.js';
import { createLogger, describeError } from '../../logger.js';

const log = createLogger('arbitration');

// Detecting a real contradiction (vs. different emphasis) and phrasing why it
// matters both need judgment — that's what this call is for. Which domain
// wins is NOT: it's a fixed lookup (higherPrioritySpecialist), applied after
// this call returns, never trusted from the model's own output. See the
// SPECIALIST_PRIORITY_TIER comment in model-config.ts.
const DETECT_CONTRADICTIONS_TOOL = {
  name: 'detect_contradictions',
  description:
    'Given multiple specialist answers to the same athlete question, identify DIRECT contradictions — claims ' +
    'that cannot both be followed at once, not just different emphasis or complementary advice on different ' +
    'aspects of the question. Be conservative: most multi-specialist answers agree or complement each other, ' +
    'and an empty list is the right answer most of the time. For each real contradiction, name the two domains ' +
    "involved, the conflicting claim in one sentence, and — given Rumble's fixed priority when specialists " +
    'conflict (recovery > cycling_coach > nutritionist/strength_conditioning) — a one-sentence, athlete-facing ' +
    "reason the higher-priority domain's view applies here specifically (not a restatement of the abstract ranking).",
  input_schema: {
    type: 'object' as const,
    properties: {
      contradictions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            domain_a: { type: 'string', description: 'One of the two specialists in this contradiction' },
            domain_b: { type: 'string', description: 'The other specialist in this contradiction' },
            issue: { type: 'string', description: 'One sentence: what directly conflicts' },
            reason: {
              type: 'string',
              description:
                "One sentence, athlete-facing, on why Rumble's priority resolves this the way it does in " +
                "this athlete's specific situation.",
            },
          },
          required: ['domain_a', 'domain_b', 'issue', 'reason'],
        },
      },
    },
    required: ['contradictions'],
  },
};

/**
 * What the arbitration classifier is expected to hand back. Parsed, not
 * asserted, for the same reason fast-path-meal-log.ts parses its classifier's
 * output rather than casting it: this shape arrives from a model, which makes
 * it the one place here where the shape is a hope rather than a guarantee.
 * `.catchall(z.unknown())` because the model sometimes volunteers extra
 * fields and none of them are a reason to discard a real contradiction.
 */
const Contradiction = z
  .object({
    domain_a: z.string(),
    domain_b: z.string(),
    issue: z.string().min(1),
    reason: z.string().min(1),
  })
  .catchall(z.unknown());

const ArbitrateResult = z.object({ contradictions: z.array(Contradiction) }).catchall(z.unknown());

export interface ResolvedContradiction {
  domainA: Specialist;
  domainB: Specialist;
  issue: string;
  /** Computed by higherPrioritySpecialist, not read from the model's output. */
  chosenDomain: Specialist;
  reason: string;
}

/**
 * Runs only when ≥2 specialists were consulted in the *same* round (see
 * chat.stream.ts) — that's the shape of "Opus dispatched two specialists
 * because it couldn't decide which was authoritative", not two specialists
 * consulted turns apart as sequential inputs to a plan, which isn't a
 * disagreement to arbitrate.
 *
 * Fails open on any error, same policy as the meal-log fast path: this is
 * additive grounding for the orchestrator's next round, never something the
 * whole turn can be lost to. An empty array either means "nothing
 * contradicted" or "arbitration didn't run" — both look the same to the
 * caller, and both mean "proceed as if arbitration hadn't happened."
 */
export async function arbitrateSpecialists(
  consults: Array<{ specialist: Specialist; response: string }>,
): Promise<ResolvedContradiction[]> {
  let decision;
  try {
    decision = await chat({
      model: 'claude-haiku-4-5',
      system: "You review a cycling coaching app's specialist consults for genuine contradictions.",
      messages: [
        {
          role: 'user',
          content: consults.map((c) => `[${c.specialist}]\n${c.response}`).join('\n\n'),
        },
      ],
      tools: [DETECT_CONTRADICTIONS_TOOL],
      toolChoice: { name: 'detect_contradictions' },
      maxTokens: 1024,
    });
  } catch (err) {
    log.warn('arbitration call failed, proceeding without it', describeError(err));
    return [];
  }

  const toolUse = decision.content.find((b): b is ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) return [];

  const parsed = ArbitrateResult.safeParse(toolUse.input);
  if (!parsed.success) {
    log.warn('arbitration returned an unusable shape, proceeding without it', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
    return [];
  }

  const resolved: ResolvedContradiction[] = [];
  for (const c of parsed.data.contradictions) {
    // The model can misname a domain or (rarely) pair one against itself —
    // neither is a contradiction this app can act on, so it's dropped rather
    // than passed through to a lookup that has no sensible answer for it.
    if (!isSpecialist(c.domain_a) || !isSpecialist(c.domain_b) || c.domain_a === c.domain_b) {
      log.warn('arbitration named an invalid or degenerate domain pair, skipping', {
        domain_a: c.domain_a,
        domain_b: c.domain_b,
      });
      continue;
    }
    resolved.push({
      domainA: c.domain_a,
      domainB: c.domain_b,
      issue: c.issue,
      chosenDomain: higherPrioritySpecialist(c.domain_a, c.domain_b),
      reason: c.reason,
    });
  }
  return resolved;
}
