import type { Response as ExpressResponse } from 'express';
import type { ToolUseBlock, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { executeToolCalls } from '../tools/tool.executor.js';
import { TOOL_REGISTRY, type ToolName } from '../tools/tool-registry.js';
import { arbitrateSpecialists, type ResolvedContradiction } from '../tools/arbitrate-specialists.js';
import type { SseFrame } from './sse-frame.js';
import { chatStream, type ChatMessage } from '../claude/claude.client.js';
import { ORCHESTRATOR_MODEL, orchestratorSystemPrompt, isSpecialist, type Specialist } from '../claude/model-config.js';
import { ORCHESTRATOR_TOOLS } from '../tools/tool.executor.js';
import { createLogger } from '../../logger.js';

const log = createLogger('orchestrate');

// Up to 3 rounds of tool calls before the orchestrator is forced to answer
// (the 4th call gets no `tools`, so it cannot emit another tool_use — this
// is what guarantees the loop terminates). Bounds latency/cost on a
// pathological request rather than looping indefinitely.
/**
 * Hard ceiling on the agentic loop. Exported so tests pin the invariant — "the
 * loop terminates at the configured bound, and the final round carries no
 * tools" — rather than today's value of it.
 */
export const MAX_TOOL_ROUNDS = 4;

// Two blocks, not one concatenated string. A cache_control marker covers its
// whole block's content, and the context preamble carries a live timestamp, so a
// combined block can never cache-hit — which would cost the persona its caching
// too, and the persona is the larger and genuinely static half. Split, the
// persona caches normally and only the small preamble is evaluated fresh.
function buildOrchestratorSystem(contextPreamble: string): TextBlockParam[] {
  return [
    { type: 'text', text: orchestratorSystemPrompt(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: contextPreamble },
  ];
}

// Multi-turn chat history grows every turn and was being resent in full,
// uncached, every time — cost scales with the square of conversation length.
// Marking a cache breakpoint on the last message lets Anthropic reuse
// everything before it; only content after the breakpoint is evaluated at
// full price. Called fresh before every round's request (not once before the
// loop) so a multi-round tool-calling turn also benefits: round 2 reads round
// 1's assistant+tool_result blocks from cache instead of resending them
// uncached, and so on for round 3. `messages` itself is never mutated with
// cache_control, so this is the only breakpoint in the array — no risk of
// drifting past the 4-marker-per-request limit as rounds accumulate.
function withTrailingCacheBreakpoint(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const idx = messages.length - 1;
  const target = messages[idx];
  const content = typeof target.content === 'string'
    ? [{ type: 'text' as const, text: target.content, cache_control: { type: 'ephemeral' as const } }]
    : target.content.map((block, i, arr) =>
        i === arr.length - 1 ? { ...block, cache_control: { type: 'ephemeral' as const } } : block,
      );
  const copy = [...messages];
  copy[idx] = { ...target, content };
  return copy;
}

interface StreamContext {
  athleteId: string;
  chatId: string;
  contextPreamble: string;
  /** Full compressed history, including the new user turn, NOT including the system prompt. */
  messages: ChatMessage[];
}

// --- SSE helpers ---

/**
 * Writes one frame. Typed as SseFrame rather than `unknown`, so a misspelled
 * `type` or a delta frame missing its `delta` is a compile error here instead
 * of a piece the client silently drops from the athlete's reply.
 */
function sse(res: ExpressResponse, data: SseFrame): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamTextStep(res: ExpressResponse, text: string): void {
  sse(res, { type: 'start-step' });
  const CHUNK = 80;
  for (let i = 0; i < text.length; i += CHUNK) {
    sse(res, { type: 'text-delta', delta: text.slice(i, i + CHUNK) });
  }
  sse(res, { type: 'finish-step' });
}

/**
 * Same SSE contract as the "no tools needed" branch below, for fast-path
 * replies (e.g. meal logging) that skip the orchestrator entirely — the
 * frontend can't tell the difference.
 */
export function pipeFastPathReply(res: ExpressResponse, chatId: string, text: string): ChatMessage[] {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
  }
  sse(res, { type: 'start', id: chatId });
  streamTextStep(res, text);
  sse(res, { type: 'finish' });
  res.write('data: [DONE]\n\n');
  return [{ role: 'assistant', content: text }];
}

// Record<Specialist, ...>, for the same reason the tool labels live on the
// registry: keyed by bare string, renaming a specialist in model-config.ts
// degrades this to "Consulting cycling_coach" and fails nowhere.
const SPECIALIST_LABELS: Record<Specialist, string> = {
  cycling_coach: 'Consulting cycling coach',
  strength_conditioning: 'Consulting S&C coach',
  nutritionist: 'Consulting nutritionist',
  recovery: 'Consulting recovery specialist',
};

/**
 * The progress line the UI shows while a tool runs.
 *
 * Both halves are keyed by a union rather than a bare string, so a new tool or
 * specialist cannot reach the UI without a label. Keyed by string, a rename
 * degrades to "Running <snake_case_name>" and fails nowhere.
 */
function toolLabel(name: string, args?: Record<string, unknown>): string {
  if (name === 'consult_specialist' && args?.specialist) {
    return SPECIALIST_LABELS[args.specialist as Specialist] || `Consulting ${args.specialist}`;
  }
  return TOOL_REGISTRY[name as ToolName]?.label || `Running ${name}`;
}

// What Opus reads before its next round when arbitration flagged something —
// orchestrator.md tells it to defer to this rather than re-litigating the
// specialists itself. Not sent to the athlete; contradiction-notice frames
// carry the short, athlete-facing version of the same resolution.
function arbitrationNoteText(resolved: ResolvedContradiction[]): string {
  const lines = resolved.map((c) =>
    c.chosenDomain
      ? `- ${c.domainA} vs ${c.domainB}: ${c.issue} — defer to ${c.chosenDomain} per Rumble's fixed priority (${c.reason})`
      // Equal-priority domains (nutritionist vs strength_conditioning today) —
      // no fixed winner to defer to. Opus makes this call itself, with the
      // full conversation context arbitrate-specialists.ts never sees.
      : `- ${c.domainA} vs ${c.domainB}: ${c.issue} — equal priority, no fixed winner. ${c.reason} Weigh it yourself and say which way you're leaning and why.`,
  );
  return [
    `Arbitration note — ${resolved.length} contradiction(s) found between this round's specialists:`,
    ...lines,
  ].join('\n');
}

// --- Main orchestration ---
//
// A real agentic loop, up to MAX_TOOL_ROUNDS: each round streams the
// orchestrator's response live (chatStream, with tools attached), then
// checks whether it asked for tools. If so: execute them, append the
// assistant+tool_result messages, and loop — the orchestrator can decide it
// needs another tool call based on what the first one returned (e.g.
// consult_specialist, then act on that specialist's answer with a second
// tool call, then answer), which a single fixed round couldn't support. The
// final round is called with no tools at all, which is what guarantees the
// loop terminates — with nothing to call, the model can only answer in
// prose, and that answer was already streamed live during that same call.
//
// Returns the new messages produced this turn, for the caller to persist.
export async function pipeStreamWithToolExecution(
  res: ExpressResponse,
  ctx: StreamContext,
): Promise<ChatMessage[]> {
  let headerSent = false;
  let reasoningStepOpen = false;
  const newMessages: ChatMessage[] = [];

  function ensureHeader(): void {
    if (!headerSent) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
      }
      sse(res, { type: 'start', id: ctx.chatId });
      headerSent = true;
    }
  }

  function openReasoningStep(): void {
    if (!reasoningStepOpen) {
      sse(res, { type: 'start-step' });
      reasoningStepOpen = true;
    }
  }

  function closeReasoningStep(): void {
    if (reasoningStepOpen) {
      sse(res, { type: 'finish-step' });
      reasoningStepOpen = false;
    }
  }

  function streamError(message: string): void {
    ensureHeader();
    closeReasoningStep();
    // One frame, one shape. chat-runtime dispatches on `frame.type`, so a
    // second differently-shaped announcement of the same event (a
    // `{ finished: true, error: { code, message } }` alongside this) is read by
    // nobody and drifts from the one that is.
    sse(res, { type: 'error', errorText: message });
    res.write('data: [DONE]\n\n');
  }

  try {
    const system = buildOrchestratorSystem(ctx.contextPreamble);
    let messages = ctx.messages;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const toolsAllowed = round < MAX_TOOL_ROUNDS - 1;

      log.debug('Round starting', {
        round: round + 1,
        maxRounds: MAX_TOOL_ROUNDS,
        chatId: ctx.chatId,
        msgCount: messages.length,
      });

      // Tools stay on the request even on the forced-answer final round —
      // dropping the array there would change the tools+system cache prefix
      // and force a full, uncached reprocess of the orchestrator persona and
      // the entire history for that call. `tool_choice: none` forbids tool
      // use just as effectively while keeping the prefix byte-identical.
      const stream = chatStream({
        model: ORCHESTRATOR_MODEL,
        system,
        messages: withTrailingCacheBreakpoint(messages),
        tools: ORCHESTRATOR_TOOLS,
        toolChoice: toolsAllowed ? undefined : { type: 'none' },
        maxTokens: 8192,
      });

      ensureHeader();
      sse(res, { type: 'start-step' });

      let roundText = '';
      stream.on('text', (delta: string) => {
        roundText += delta;
        sse(res, { type: 'text-delta', delta });
      });

      const decision = await stream.finalMessage();
      sse(res, { type: 'finish-step' });

      if (decision.stop_reason === 'max_tokens') {
        log.warn('Round hit max_tokens', { round: round + 1, chatId: ctx.chatId });
      }

      const toolUseBlocks = decision.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      log.debug('Round complete', { round: round + 1, toolCalls: toolUseBlocks.length, stopReason: decision.stop_reason });

      // ── No tools requested — roundText is the final answer, already streamed live ──
      if (toolUseBlocks.length === 0) {
        sse(res, { type: 'finish', usage: decision.usage });
        res.write('data: [DONE]\n\n');
        newMessages.push({ role: 'assistant', content: roundText });
        return newMessages;
      }

      // ── Tools requested — execute, append, loop for another round ──
      openReasoningStep();
      const toolNames = toolUseBlocks.map((b) => toolLabel(b.name, b.input as Record<string, unknown>));
      sse(res, { type: 'reasoning-delta', delta: toolNames.join(' · ') + '\n' });

      log.debug('Executing tools', { tools: toolUseBlocks.map((t) => t.name) });

      const toolResults = await executeToolCalls(
        toolUseBlocks.map((b) => ({ id: b.id, name: b.name, arguments: b.input as Record<string, unknown> })),
        ctx.athleteId,
      );

      for (const tr of toolResults) {
        const isError = 'error' in tr && tr.error;
        log.debug('Tool finished', { tool: tr.name, ok: !isError, ...(isError ? { error: tr.error } : {}) });
      }

      closeReasoningStep();

      // A specialist's full answer, in their own voice — a card distinct from
      // the orchestrator's own text, not folded into the reasoning trace above.
      // Sent per successful consult_specialist call, in the order they resolved.
      // Also collected for arbitration below: more than one specialist
      // consulted in the *same* round is the shape of "Opus couldn't decide
      // which was authoritative" — not two consults turns apart as
      // sequential inputs to a plan, which isn't a disagreement to arbitrate.
      const specialistConsults: Array<{ specialist: Specialist; text: string }> = [];
      for (const tr of toolResults) {
        if (tr.name !== 'consult_specialist' || tr.error) continue;
        const result = tr.result as { specialist?: unknown; response?: unknown } | null;
        const specialist = typeof result?.specialist === 'string' ? result.specialist : null;
        const text = typeof result?.response === 'string' ? result.response : null;
        if (specialist && isSpecialist(specialist) && text) {
          sse(res, { type: 'specialist-message', specialist, text });
          specialistConsults.push({ specialist, text });
        }
      }

      // Fails open (see arbitrateSpecialists) — an empty result either means
      // "nothing contradicted" or "arbitration didn't run", and both mean
      // "proceed exactly as before this feature existed".
      let arbitrationNote = '';
      if (specialistConsults.length > 1) {
        const resolved = await arbitrateSpecialists(
          specialistConsults.map((c) => ({ specialist: c.specialist, response: c.text })),
        );
        // One line, matching every other sse() call in this file — sse-frame.test.ts
        // scans for `sse(res, { type: '...'` on a single line to confirm every frame
        // this file emits is declared in the SseFrame union. Skipped on a genuine
        // tie (chosenDomain null) — there's no winner to name on the card, and
        // Opus's own answer (grounded by arbitrationNote above) carries the nuance.
        for (const c of resolved) {
          if (!c.chosenDomain) continue;
          sse(res, { type: 'contradiction-notice', domains: [c.domainA, c.domainB], chosenDomain: c.chosenDomain, oneLineReason: c.reason });
        }
        if (resolved.length > 0) arbitrationNote = arbitrationNoteText(resolved);
      }

      // assistant turn carrying the tool_use blocks — Claude requires the raw
      // content array to be replayed back unchanged for tool_result matching
      const assistantMsg: ChatMessage = { role: 'assistant', content: decision.content };

      const MAX_TOOL_RESULT_CHARS = 8000;
      const toolResultBlocks = toolResults.map((tr) => {
        let text = JSON.stringify(tr.error ? { error: tr.error } : tr.result);
        if (text.length > MAX_TOOL_RESULT_CHARS) text = text.slice(0, MAX_TOOL_RESULT_CHARS) + '... [truncated]';
        return {
          type: 'tool_result' as const,
          tool_use_id: tr.tool_call_id,
          content: text,
          is_error: Boolean(tr.error),
        };
      });
      // Rides alongside the real tool_result blocks as a plain text block,
      // not as a tool_result of its own — Claude requires every tool_result
      // to match a real tool_use id from this same round, and there's no
      // tool_use this note is answering. A user-role message can carry extra
      // content blocks beside its tool_results; this is that.
      const toolResultContent = arbitrationNote
        ? [...toolResultBlocks, { type: 'text' as const, text: arbitrationNote }]
        : toolResultBlocks;
      const toolResultMsg: ChatMessage = { role: 'user', content: toolResultContent };

      newMessages.push(assistantMsg, toolResultMsg);
      messages = [...messages, assistantMsg, toolResultMsg];
    }

    // Unreachable in practice — the last round is always called with
    // toolsAllowed=false, so the model has nothing to call and must answer,
    // which returns from inside the loop above. Guarded anyway.
    streamError('The coach needed more steps than allowed to answer this — try breaking your request into smaller parts.');
    return newMessages;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    log.error('Fatal error during orchestration', { error: msg });
    if (headerSent) {
      streamError('The AI service is temporarily unavailable. Please try again.');
      return newMessages;
    }
    throw err;
  }
}
