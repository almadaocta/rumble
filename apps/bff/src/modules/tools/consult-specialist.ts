import { z } from 'zod';
import { chat, systemBlock } from '../claude/claude.client.js';
import { getSpecialist, isSpecialist, SPECIALIST_NAMES } from '../claude/model-config.js';
import type { ToolOutcome } from './tool-result.js';

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

  const config = getSpecialist(specialist);

  const MAX_CONTEXT_CHARS = 2000;
  let contextStr = athlete_context ? JSON.stringify(athlete_context) : '';
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

/**
 * One-line preview of a consult, for the reasoning stream in chat.stream.ts.
 *
 * Lives here because this module owns the result shape. Reaching into the
 * result from chat.stream.ts instead would mean plucking `.response` off an
 * `unknown` by name — renaming that field degrades the UI to no preview at all
 * and fails nowhere.
 */
export function summarizeConsult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const { response } = result as { response?: unknown };
  if (typeof response !== 'string') return null;

  const firstLine = response.split('\n').find((line) => line.trim().length > 10)?.trim();
  if (!firstLine) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}
