import { z } from 'zod';
import { chat, systemBlock } from '../claude/claude.client.js';
import { getSpecialist, getContextContract, isSpecialist, SPECIALIST_NAMES } from '../claude/model-config.js';
import type { ToolOutcome } from './tool-result.js';
import { formatZodIssues } from './format-zod-error.js';

const ConsultArgs = z.object({
  specialist: z.string(),
  query: z.string(),
  athlete_context: z.record(z.string(), z.unknown()).optional(),
});

export async function consultSpecialist(
  args: Record<string, unknown>,
  _athleteId: string,
): Promise<ToolOutcome> {
  const { specialist, query, athlete_context } = ConsultArgs.parse(args);

  if (!isSpecialist(specialist)) {
    return {
      ok: false,
      error: `Unknown specialist: ${specialist}. Available: ${SPECIALIST_NAMES.join(', ')}`,
    };
  }

  // Validated before the specialist is ever called — a missing required
  // field (e.g. weight_kg for the nutritionist) fails the tool call with a
  // named-field error instead of the specialist quietly reasoning without
  // it, and instead of spending a Haiku call on a consult that was always
  // going to be under-informed. Unknown keys the orchestrator threw in are
  // stripped by the schema, not passed through — the specialist should only
  // ever see the context its own contract asked for.
  const contract = getContextContract(specialist);
  const parsedContext = contract.safeParse(athlete_context ?? {});
  if (!parsedContext.success) {
    return {
      ok: false,
      specialist,
      error:
        `${specialist} needs more context — ${formatZodIssues(parsedContext.error.issues)}. ` +
        'Fetch the missing data (e.g. get_athlete_context) and call consult_specialist again with it in athlete_context.',
    };
  }

  const config = getSpecialist(specialist);

  const MAX_CONTEXT_CHARS = 2000;
  let contextStr = JSON.stringify(parsedContext.data);
  if (contextStr.length > MAX_CONTEXT_CHARS) {
    contextStr = contextStr.slice(0, MAX_CONTEXT_CHARS) + '... [truncated]';
  }

  const userContent = [
    contextStr ? `Athlete context:\n${contextStr}\n\n` : '',
    `Question: ${query}`,
  ].join('');

  const response = await chat({
    model: config.model,
    // Persona + this specialist's entire document library, as one cache-eligible
    // prefix. It's byte-identical on every consult to this specialist, so only
    // the first call inside the cache TTL pays to send it; the rest read it back
    // at roughly a tenth of input price. Only the question and athlete context
    // vary, and those go in the user turn — after the cached prefix.
    system: systemBlock(`${config.systemPrompt}\n\n${config.knowledgeBase}`, true),
    messages: [{ role: 'user', content: userContent }],
    maxTokens: 2048,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const content = textBlock?.type === 'text' ? textBlock.text : '';

  if (!content) {
    return { ok: false, specialist, error: 'Specialist returned empty response' };
  }

  return {
    ok: true,
    specialist,
    response: content,
  };
}
