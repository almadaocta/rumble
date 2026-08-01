import type { ChatMessage } from '../claude/claude.client.js';
import { createLogger } from '../../logger.js';

const log = createLogger('context');

const CHARS_PER_TOKEN = 4;
const MAX_TOKENS = 120_000;
const KEEP_RECENT_PAIRS = 10;

function messageChars(m: ChatMessage): number {
  return typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
}

function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + messageChars(m), 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Tool results travel back to the API as `role: 'user'` messages carrying
 * `tool_result` blocks, so role alone doesn't identify a real user turn.
 */
function isToolResultTurn(message: ChatMessage): boolean {
  if (typeof message.content === 'string') return false;
  return message.content.some((block) => block.type === 'tool_result');
}

/**
 * Indices we can safely cut the history at.
 *
 * Only genuine user turns qualify. Counting tool-result messages here meant a
 * trim could land on one and slice away the assistant `tool_use` block it
 * answers — the API rejects a `tool_result` with no matching `tool_use`, so a
 * long tool-heavy conversation would start failing at exactly the point
 * trimming kicked in.
 */
function findUserTurnBoundaries(messages: ChatMessage[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && !isToolResultTurn(messages[i])) boundaries.push(i);
  }
  return boundaries;
}

/**
 * Lightweight safety net for long conversations. There's no server-side
 * conversation store anymore (a prior hosted version had that) — chat_messages
 * in SQLite is the only history, and this is the only thing bounding what gets
 * resent to Claude every turn. The system prompt (context preamble) is
 * separate from `messages`, so it's never at risk of being trimmed here.
 */
export function compressMessages(messages: ChatMessage[]): ChatMessage[] {
  const totalTokens = estimateTokens(messages);
  const pairStarts = findUserTurnBoundaries(messages);

  log.debug('Context size', {
    messages: messages.length,
    userTurns: pairStarts.length,
    estimatedTokens: totalTokens,
  });

  if (totalTokens <= MAX_TOKENS && pairStarts.length <= KEEP_RECENT_PAIRS) return messages;

  const keepCount = Math.min(KEEP_RECENT_PAIRS, pairStarts.length - 1);
  const cutoffIdx = pairStarts[pairStarts.length - keepCount];
  const result = messages.slice(cutoffIdx);
  const newTokens = estimateTokens(result);

  log.info('Trimmed conversation history', {
    messagesBefore: messages.length,
    messagesAfter: result.length,
    tokensBefore: totalTokens,
    tokensAfter: newTokens,
    keptUserTurns: KEEP_RECENT_PAIRS,
  });

  return result;
}
