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
 * Replace the content of tool_result blocks that fall before the recency
 * cutoff index. This prevents large tool payloads from old turns from being
 * replayed in every subsequent API call.
 *
 * We stub the content rather than removing the message entirely — the
 * tool_use/tool_result pair must stay structurally intact or the API rejects
 * the conversation. The stub is short enough that it's nearly free.
 */
function stubOldToolResults(messages: ChatMessage[], cutoffIdx: number): ChatMessage[] {
  return messages.map((m, i) => {
    if (i >= cutoffIdx) return m; // recent — leave untouched
    if (typeof m.content === 'string') return m;
    const hasToolResult = m.content.some((b) => b.type === 'tool_result');
    if (!hasToolResult) return m;

    return {
      ...m,
      content: m.content.map((b) => {
        if (b.type !== 'tool_result') return b;
        return { ...b, content: '[tool result omitted]' };
      }),
    };
  });
}

/**
 * Lightweight safety net for long conversations. There's no server-side
 * conversation store anymore (a prior hosted version had that) — chat_messages
 * in SQLite is the only history, and this is the only thing bounding what gets
 * resent to Claude every turn. The system prompt (context preamble) is
 * separate from `messages`, so it's never at risk of being trimmed here.
 *
 * Two-stage compression:
 * 1. Trim (token budget exceeded): drop messages before the recency cutoff.
 * 2. Stub (turn count exceeded): replace tool_result content in the older
 *    portion of what's kept so large payloads aren't resent on every call.
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

  // - 1: guarantees at least one message is dropped when token budget triggers trim
  const keepCount = Math.min(KEEP_RECENT_PAIRS, pairStarts.length - 1);
  if (keepCount <= 0) return messages;
  const trimCutoffIdx = pairStarts[pairStarts.length - keepCount];

  // Stage 1: trim if over token budget — drop old messages entirely.
  const trimmed = totalTokens > MAX_TOKENS ? messages.slice(trimCutoffIdx) : messages;

  // Stage 2: stub old tool-result payloads within the kept window.
  // Re-examine boundaries in the (possibly trimmed) result and stub anything
  // older than KEEP_RECENT_PAIRS turns within it.
  const keptBoundaries = findUserTurnBoundaries(trimmed);
  const stubKeepCount = Math.min(KEEP_RECENT_PAIRS, keptBoundaries.length);
  // Use half the keep window as the "recent" zone so stubbing is visible even
  // when the kept window is exactly KEEP_RECENT_PAIRS turns.
  const stubRecentCount = Math.ceil(stubKeepCount / 2);
  const stubCutoffIdx =
    keptBoundaries.length > stubRecentCount
      ? keptBoundaries[keptBoundaries.length - stubRecentCount]
      : 0;

  const result =
    stubCutoffIdx > 0 ? stubOldToolResults(trimmed, stubCutoffIdx) : trimmed;

  const newTokens = estimateTokens(result);

  log.info('Trimmed conversation history', {
    messagesBefore: messages.length,
    messagesAfter: result.length,
    tokensBefore: totalTokens,
    tokensAfter: newTokens,
    keptUserTurns: keepCount,
  });

  return result;
}
