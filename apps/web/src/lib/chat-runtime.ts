import { useCallback, useRef, useState } from 'react';
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadAssistantMessagePart,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { getJson } from '@/lib/api';
import type { SseFrame } from '@/lib/api-types';
import { isSpecialist, SPECIALIST_META, type Specialist } from '@/lib/specialists';

export const CHAT_ID_STORAGE_KEY = 'rumble.chatId';

/**
 * Who authored an assistant message, read from its metadata so
 * AssistantMessage.tsx can pick the right avatar/label. Defaults to
 * 'orchestrator' for anything without a recognized speaker tag — older rows,
 * or a specialist name that no longer exists.
 */
export type Speaker = 'orchestrator' | Specialist;

export function speakerOf(metadata: ThreadMessageLike['metadata'] | undefined): Speaker {
  const speaker = metadata?.custom?.speaker;
  return isSpecialist(speaker) ? speaker : 'orchestrator';
}

/** True for a contradiction-notice message — AssistantMessage.tsx renders it as a short, unattributed line rather than a normal speaker bubble. */
export function isContradictionNotice(metadata: ThreadMessageLike['metadata'] | undefined): boolean {
  return metadata?.custom?.kind === 'contradiction-notice';
}

function contradictionMessage(text: string): ThreadMessageLike {
  return {
    role: 'assistant',
    content: text,
    status: { type: 'complete', reason: 'unknown' },
    metadata: { custom: { kind: 'contradiction-notice' } },
  };
}

function orchestratorMessage(
  content: ThreadMessageLike['content'],
  status: ThreadMessageLike['status'],
): ThreadMessageLike {
  return { role: 'assistant', content, status, metadata: { custom: { speaker: 'orchestrator' } } };
}

function specialistMessage(specialist: Specialist, text: string): ThreadMessageLike {
  return {
    role: 'assistant',
    content: text,
    status: { type: 'complete', reason: 'unknown' },
    metadata: { custom: { speaker: specialist } },
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: 'text'; text: string } => p?.type === 'text')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

interface RawContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
}

/**
 * Pulls a specialist's full answer back out of a stored consult_specialist
 * tool_use/tool_result pair. The result block's `content` is the JSON string
 * chat.stream.ts wrote (and may have been truncated past MAX_TOOL_RESULT_CHARS
 * for a very long answer) — a parse failure just means this consult doesn't
 * get a message on reload, not a broken page.
 */
function specialistFromToolResult(
  resultBlock: RawContentBlock | undefined,
): { specialist: Specialist; text: string } | null {
  if (typeof resultBlock?.content !== 'string') return null;
  try {
    const parsed = JSON.parse(resultBlock.content) as { specialist?: unknown; response?: unknown };
    if (isSpecialist(parsed.specialist) && typeof parsed.response === 'string') {
      return { specialist: parsed.specialist, text: parsed.response };
    }
  } catch {
    // Truncated or malformed — treated as "no message", not an error.
  }
  return null;
}

/**
 * Rebuilds one tool-round assistant turn (raw Anthropic content blocks) into
 * zero or more top-level messages — the orchestrator's own prose (if any),
 * then one separate message per consult_specialist call in the round, each
 * tagged with its speaker. Matches the live path (see useRumbleChatRuntime):
 * a specialist's reply is a genuine standalone message, not something nested
 * inside the orchestrator's. Other tool calls stay internal, same as before
 * this reconstruction existed — only consult_specialist has a voice worth
 * showing.
 */
function reconstructToolRound(
  assistantBlocks: RawContentBlock[],
  resultBlocks: RawContentBlock[],
): ThreadMessageLike[] {
  const resultsByToolUseId = new Map(resultBlocks.map((b) => [b.tool_use_id, b]));

  const text = assistantBlocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');

  const specialistMessages = assistantBlocks
    .filter((b) => b.type === 'tool_use' && b.name === 'consult_specialist')
    .map((b) => specialistFromToolResult(resultsByToolUseId.get(b.id)))
    .filter((d): d is { specialist: Specialist; text: string } => d !== null)
    .map((d) => specialistMessage(d.specialist, d.text));

  return [
    ...(text ? [orchestratorMessage(text, { type: 'complete', reason: 'unknown' })] : []),
    ...specialistMessages,
  ];
}

/**
 * Fetches the persisted history for the last-used chat (if any).
 *
 * Plain user/assistant text rows render as-is. Tool-round rows (raw Anthropic
 * content blocks — tool_use/tool_result — kept for the backend's own context
 * continuity) are mostly internal machinery not meant for direct display, with
 * one exception: a consult_specialist call is reconstructed into its own
 * speaker-tagged message, so a specialist's answer survives a page refresh
 * instead of vanishing along with the rest of that round's tool noise.
 */
export async function loadInitialMessages(): Promise<ThreadMessageLike[]> {
  const chatId = localStorage.getItem(CHAT_ID_STORAGE_KEY);
  if (!chatId) return [];

  try {
    const data = await getJson<{ messages: Array<{ role: string; content: unknown }> }>(
      `/api/chat/chats/${chatId}`,
    );
    const rows = data.messages ?? [];
    const out: ThreadMessageLike[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.role === 'user' && typeof row.content === 'string') {
        out.push({ role: 'user', content: row.content });
        continue;
      }
      if (row.role === 'assistant' && typeof row.content === 'string') {
        out.push(orchestratorMessage(row.content, { type: 'complete', reason: 'unknown' }));
        continue;
      }
      if (row.role === 'assistant' && Array.isArray(row.content)) {
        // The tool_result reply is always the very next row — chat.controller.ts
        // persists [assistantMsg, toolResultMsg] as one consecutive pair.
        const next = rows[i + 1];
        const resultBlocks = Array.isArray(next?.content) && next.role === 'user' ? next.content : [];
        out.push(...reconstructToolRound(row.content as RawContentBlock[], resultBlocks as RawContentBlock[]));
        if (resultBlocks.length > 0) i++; // consumed as this round's tool_result
        continue;
      }
      // role 'system', or a shape this thread can't render — dropped.
    }

    return out;
  } catch {
    return [];
  }
}

/**
 * Chat runtime built on useExternalStoreRuntime rather than useLocalRuntime.
 *
 * useLocalRuntime's ChatModelAdapter is built around "one user turn → one
 * assistant message" — the avatar renders once per message, not once per
 * part, so a consult_specialist reply could only ever show up nested inside
 * the orchestrator's own message bubble. Owning the message array directly
 * lets a specialist's reply become a real, separate top-level message with
 * its own speaker — three actual messages per turn when a specialist is
 * consulted (orchestrator, specialist, orchestrator), each rendered with the
 * correct avatar by AssistantMessage.tsx reading metadata.custom.speaker.
 */
export function useRumbleChatRuntime(initialMessages: ThreadMessageLike[]) {
  const [messages, setMessages] = useState<readonly ThreadMessageLike[]>(initialMessages);
  const [isRunning, setIsRunning] = useState(false);
  const chatIdRef = useRef<string | undefined>(localStorage.getItem(CHAT_ID_STORAGE_KEY) ?? undefined);
  const abortControllerRef = useRef<AbortController | null>(null);

  const onNew = useCallback(async (message: AppendMessage) => {
    const userText = textOf(message.content);

    // Seeded from the functional updater so a message sent mid-render can't
    // build off a stale closure of `messages` — every later mutation in this
    // turn reassigns `working` directly, since nothing else writes to
    // `messages` while a turn (isRunning) is in flight.
    let working: ThreadMessageLike[] = [];
    setMessages((prev) => {
      working = [...prev, { role: 'user', content: userText }];
      return working;
    });
    setIsRunning(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    let reasoning = '';
    let text = '';
    let orchestratorOpen = false;

    function openOrchestrator() {
      working = [...working, orchestratorMessage([], { type: 'running' })];
      orchestratorOpen = true;
      reasoning = '';
      text = '';
    }

    function currentParts(): ThreadAssistantMessagePart[] {
      const parts: ThreadAssistantMessagePart[] = [];
      if (reasoning) parts.push({ type: 'reasoning', text: reasoning });
      if (text) parts.push({ type: 'text', text });
      return parts;
    }

    function flush(status: ThreadMessageLike['status']) {
      const idx = working.length - 1;
      working = working.map((m, i) => (i === idx ? orchestratorMessage(currentParts(), status) : m));
      setMessages(working);
    }

    function closeOrchestrator() {
      if (!orchestratorOpen) return;
      flush({ type: 'complete', reason: 'unknown' });
      orchestratorOpen = false;
    }

    try {
      const response = await fetch('/api/chat/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only the new user turn — chat.controller.ts rebuilds history itself
        // from chatId server-side; the rest of the thread was never read.
        body: JSON.stringify({ chatId: chatIdRef.current, messages: [{ role: 'user', content: userText }] }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Chat request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const raw of frames) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          const frame = JSON.parse(payload) as SseFrame;

          // A switch on the discriminant rather than a chain of
          // `frame.type === 'x' && frame.delta` guards. Those guards read as
          // defensive but were doing narrowing work the all-optional frame
          // type couldn't: an empty delta was indistinguishable from a
          // missing one, and both were dropped. The frames that need no
          // handling are listed rather than falling through, so adding one
          // to the union without deciding what to do with it is a compile
          // error at `exhaustive`.
          switch (frame.type) {
            case 'start':
              chatIdRef.current = frame.id;
              localStorage.setItem(CHAT_ID_STORAGE_KEY, frame.id);
              break;
            case 'text-delta':
              if (!orchestratorOpen) openOrchestrator();
              text += frame.delta;
              flush({ type: 'running' });
              break;
            case 'reasoning-delta':
              if (!orchestratorOpen) openOrchestrator();
              reasoning += frame.delta;
              flush({ type: 'running' });
              break;
            case 'specialist-message':
              // Close the orchestrator's current message so its own later
              // text (round 2's wrap-up) starts a fresh one rather than
              // resuming this one out of order.
              closeOrchestrator();
              working = [...working, specialistMessage(frame.specialist, frame.text)];
              setMessages(working);
              break;
            case 'contradiction-notice': {
              // Sent after the specialist-message frames it refers to and
              // before the orchestrator's own next-round text (which
              // chat.stream.ts's orchestrator prompt tells it to defer to,
              // not re-explain) — so it belongs between them here too.
              closeOrchestrator();
              const [domainA, domainB] = frame.domains;
              const text =
                `${SPECIALIST_META[domainA].label} and ${SPECIALIST_META[domainB].label} saw this differently — ` +
                `went with the ${SPECIALIST_META[frame.chosenDomain].label} answer: ${frame.oneLineReason}`;
              working = [...working, contradictionMessage(text)];
              setMessages(working);
              break;
            }
            case 'error':
              throw new Error(frame.errorText || 'The AI service is temporarily unavailable.');
            // Structural only — the parts are rebuilt from accumulated text
            // on every delta and once more when a message closes.
            case 'start-step':
            case 'finish-step':
            case 'finish':
              break;
            default: {
              const exhaustive: never = frame;
              void exhaustive;
            }
          }
        }
      }

      closeOrchestrator();
    } catch (err) {
      if (controller.signal.aborted) {
        closeOrchestrator();
        return;
      }
      const message = err instanceof Error ? err.message : 'The AI service is temporarily unavailable.';
      if (orchestratorOpen) {
        flush({ type: 'incomplete', reason: 'error', error: message });
      } else {
        working = [...working, orchestratorMessage(text || message, { type: 'incomplete', reason: 'error', error: message })];
        setMessages(working);
      }
    } finally {
      setIsRunning(false);
      abortControllerRef.current = null;
    }
  }, []);

  const onCancel = useCallback(async () => {
    abortControllerRef.current?.abort();
  }, []);

  return useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    setMessages,
    isRunning,
    onNew,
    onCancel,
    convertMessage: (m) => m,
  });
}
