import Anthropic from '@anthropic-ai/sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import type {
  MessageParam,
  Message,
  TextBlockParam,
  Tool,
  ToolUnion,
  ToolChoice,
} from '@anthropic-ai/sdk/resources/messages';
import { config } from '../../config.js';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export type ChatMessage = MessageParam;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A system prompt, optionally cache-eligible (static personas/tool defs should set cache: true). */
export function systemBlock(text: string, cache = false): TextBlockParam[] {
  return [
    {
      type: 'text',
      text,
      ...(cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    },
  ];
}

// Tool schemas are 100% static (never vary per-call) but were never marked
// cacheable, so all ~14 of them were sent at full price on every single
// orchestrator call. Marking the last one caches the whole array as a unit.
function toAnthropicTools(tools?: ToolDefinition[]): ToolUnion[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map(
    (t, i): Tool => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Tool['input_schema'],
      ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }),
  );
}

export interface ChatRequest {
  model: string;
  system: string | TextBlockParam[];
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Force a specific tool call (e.g. a classifier that must always return structured output). */
  toolChoice?: { name: string };
  maxTokens?: number;
}

function toToolChoice(choice?: { name: string }): ToolChoice | undefined {
  return choice ? { type: 'tool', name: choice.name } : undefined;
}

/** Non-streaming call — used for the orchestrator's tool-decision phase and specialist consults. */
export async function chat(req: ChatRequest): Promise<Message> {
  return anthropic.messages.create({
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    system: req.system,
    messages: req.messages,
    tools: toAnthropicTools(req.tools),
    tool_choice: toToolChoice(req.toolChoice),
  });
}

/** Streaming call — used for the final response streamed to the frontend. */
export function chatStream(req: ChatRequest): MessageStream {
  return anthropic.messages.stream({
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    system: req.system,
    messages: req.messages,
    tools: toAnthropicTools(req.tools),
    tool_choice: toToolChoice(req.toolChoice),
  });
}

export { anthropic };
