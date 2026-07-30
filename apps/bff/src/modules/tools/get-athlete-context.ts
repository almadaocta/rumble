import { buildDetailedContext } from '../athlete/context-preamble.js';
import type { ToolOutcome } from './tool-result.js';

export async function getAthleteContext(
  _args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const context = await buildDetailedContext(athleteId);
  return { ok: true, context };
}
