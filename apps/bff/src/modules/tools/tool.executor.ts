import { z } from 'zod';
import type { ToolDefinition } from '../claude/claude.client.js';
import { createLogger, describeError } from '../../logger.js';
import { wahooEnabled } from '../../config.js';
import {
  ALL_TOOL_DEFINITIONS,
  ALL_TOOL_HANDLERS,
  type ToolHandler,
  type ToolName,
} from './tool-registry.js';

const log = createLogger('tools');

export type { ToolName } from './tool-registry.js';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  result: unknown;
  error?: string;
}

/**
 * Tools that cannot work without a configured Wahoo connection.
 *
 * These come off the list the orchestrator is shown when `wahooEnabled` is
 * false. Gating only the HTTP router isn't enough: the model would still be
 * handed push_workout_to_device and offer to send a workout to a device the app
 * has no credentials for, failing at the token lookup several layers after it
 * had already promised the athlete it would work. index.ts calls that state
 * "chat-only mode"; this is what makes the flag mean it.
 */
const WAHOO_DEPENDENT_TOOLS = new Set<ToolName>(['push_workout_to_device']);

const TOOL_HANDLERS: Partial<Record<ToolName, ToolHandler>> = wahooEnabled
  ? ALL_TOOL_HANDLERS
  : Object.fromEntries(
      Object.entries(ALL_TOOL_HANDLERS).filter(
        ([name]) => !WAHOO_DEPENDENT_TOOLS.has(name as ToolName),
      ),
    );

export async function executeToolCall(toolCall: ToolCall, athleteId: string): Promise<ToolResult> {
  const handler = TOOL_HANDLERS[toolCall.name as ToolName];
  if (!handler) {
    return {
      tool_call_id: toolCall.id,
      name: toolCall.name,
      result: null,
      error: `Unknown tool: ${toolCall.name}`,
    };
  }

  try {
    const result = await handler(toolCall.arguments, athleteId);
    return { tool_call_id: toolCall.id, name: toolCall.name, result };
  } catch (err) {
    log.error('Tool failed', { tool: toolCall.name, ...describeError(err) });
    return {
      tool_call_id: toolCall.id,
      name: toolCall.name,
      result: null,
      error: toolErrorMessage(err),
    };
  }
}

/**
 * Turns a thrown value into something the model can act on.
 *
 * All 15 handlers validate with `zod().parse`, so a malformed argument arrives
 * here as a ZodError — whose bare `.message` is a JSON dump of the whole issue
 * array. Naming the offending fields instead lets the model correct the call
 * rather than guess, and doing it here means every tool gets it from one place.
 */
function toolErrorMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    const issues = err.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return `Invalid arguments — ${issues}`;
  }
  return err instanceof Error ? err.message : 'Tool execution failed';
}

export async function executeToolCalls(
  toolCalls: ToolCall[],
  athleteId: string,
): Promise<ToolResult[]> {
  return Promise.all(toolCalls.map((tc) => executeToolCall(tc, athleteId)));
}

/**
 * Strips Wahoo-only capabilities from what the orchestrator is shown.
 *
 * Two levels: whole tools listed in WAHOO_DEPENDENT_TOOLS disappear, and
 * update_ftp_and_zones keeps working but loses its `push_to_device` option —
 * the zone update itself is local, only the push needs Wahoo.
 */
function withoutWahooCapabilities(defs: ToolDefinition[]): ToolDefinition[] {
  return defs
    .filter((tool) => !WAHOO_DEPENDENT_TOOLS.has(tool.name as ToolName))
    .map((tool) => {
      if (tool.name !== 'update_ftp_and_zones') return tool;
      const schema = tool.input_schema as { properties?: Record<string, unknown> };
      const properties = { ...schema.properties };
      delete properties.push_to_device;
      return { ...tool, input_schema: { ...schema, properties } };
    });
}

export const ORCHESTRATOR_TOOLS: ToolDefinition[] = wahooEnabled
  ? ALL_TOOL_DEFINITIONS
  : withoutWahooCapabilities(ALL_TOOL_DEFINITIONS);
