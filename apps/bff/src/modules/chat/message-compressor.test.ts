import { describe, it, expect } from 'vitest';
import { compressMessages } from './message-compressor.js';
import type { ChatMessage } from '../claude/claude.client.js';

const BIG = 'x'.repeat(60_000); // ~15k tokens each, so a handful blows the budget

function userTurn(text: string): ChatMessage {
  return { role: 'user', content: text };
}

function assistantText(text: string): ChatMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function assistantToolUse(id: string): ChatMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'get_training_data', input: {} }],
  };
}

function toolResult(id: string, text: string): ChatMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
  };
}

/**
 * Builds a conversation shaped like the orchestrator's real output: each user
 * question drives several tool rounds before the final answer.
 *
 * `toolRounds` matters. Tool results carry role 'user', so with one round per
 * turn the user-role messages alternate and a naive boundary scan happens to
 * land on a real user turn by parity. At two or more rounds — which the
 * orchestrator's multi-round loop routinely produces — it lands on a tool
 * result instead, and the trim orphans it.
 */
function buildConversation(rounds: number, toolRounds: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let r = 0; r < rounds; r++) {
    messages.push(userTurn(`question ${r} ${BIG}`));
    for (let t = 0; t < toolRounds; t++) {
      const id = `toolu_${r}_${t}`;
      messages.push(assistantToolUse(id));
      messages.push(toolResult(id, `result ${r}.${t}`));
    }
    messages.push(assistantText(`answer ${r}`));
  }
  return messages;
}

/** Every tool_result must still have its tool_use earlier in the list. */
function hasOrphanedToolResult(messages: ChatMessage[]): boolean {
  const seenToolUseIds = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') seenToolUseIds.add(block.id);
      if (block.type === 'tool_result' && !seenToolUseIds.has(block.tool_use_id)) return true;
    }
  }
  return false;
}

describe('compressMessages', () => {
  it('returns the conversation untouched when it fits in the budget', () => {
    const messages = [userTurn('hi'), assistantText('hello')];
    expect(compressMessages(messages)).toEqual(messages);
  });

  // Several shapes, because whether the bug bites depends on how many tool
  // rounds sit between user turns.
  for (const toolRounds of [1, 2, 3]) {
    it(`never orphans a tool_result with ${toolRounds} tool round(s) per turn`, () => {
      const messages = buildConversation(20, toolRounds);
      const result = compressMessages(messages);

      expect(result.length).toBeLessThan(messages.length);
      expect(hasOrphanedToolResult(result)).toBe(false);
    });

    it(`starts the trimmed history at a real user turn with ${toolRounds} tool round(s)`, () => {
      const [first] = compressMessages(buildConversation(20, toolRounds));
      expect(first.role).toBe('user');
      expect(typeof first.content).toBe('string');
    });
  }

  it('keeps the most recent exchanges rather than the oldest', () => {
    const result = compressMessages(buildConversation(20, 2));
    const rendered = JSON.stringify(result);
    expect(rendered).toContain('question 19');
    expect(rendered).not.toContain('question 0 ');
  });

  it('trims when token budget is exceeded even with few turns', () => {
    // 3 turns, each with a massive message — well under KEEP_RECENT_PAIRS=10
    // but blows the 120k token budget. The AND bug lets this through untrimmed.
    const HUGE = 'x'.repeat(200_000); // ~50k tokens each, 3 × 50k = 150k > 120k
    const messages = [
      userTurn(`q1 ${HUGE}`),
      assistantText('a1'),
      userTurn(`q2 ${HUGE}`),
      assistantText('a2'),
      userTurn(`q3 ${HUGE}`),
      assistantText('a3'),
    ];
    const result = compressMessages(messages);
    // Should be trimmed — not equal to the original
    expect(result.length).toBeLessThan(messages.length);
  });
});
