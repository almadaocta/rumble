import { useRef } from 'react';
import { useLocalRuntime, type ChatModelAdapter, type ThreadAssistantMessagePart, type ThreadMessageLike } from '@assistant-ui/react';
import { getJson } from '@/lib/api';
import type { SseFrame } from '@/lib/api-types';

export const CHAT_ID_STORAGE_KEY = 'rumble.chatId';

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

/**
 * Fetches the persisted history for the last-used chat (if any), keeping
 * only plain-text rows — turns that involved tool calls also persist raw
 * Anthropic content blocks (tool_use/tool_result) for the backend's own
 * context continuity, which aren't meant for direct display.
 */
export async function loadInitialMessages(): Promise<ThreadMessageLike[]> {
  const chatId = localStorage.getItem(CHAT_ID_STORAGE_KEY);
  if (!chatId) return [];

  try {
    const data = await getJson<{ messages: Array<{ role: string; content: unknown }> }>(
      `/api/chat/chats/${chatId}`,
    );
    const rows = data.messages ?? [];

    return rows
      .filter((r) => (r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string')
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content as string }));
  } catch {
    return [];
  }
}

function createAdapter(chatIdRef: { current: string | undefined }): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const wireMessages = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: textOf(m.content) }));

      const response = await fetch('/api/chat/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: chatIdRef.current, messages: wireMessages }),
        signal: abortSignal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Chat request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      let reasoning = '';

      function buildParts(): ThreadAssistantMessagePart[] {
        const parts: ThreadAssistantMessagePart[] = [];
        if (reasoning) parts.push({ type: 'reasoning', text: reasoning });
        if (text) parts.push({ type: 'text', text });
        return parts;
      }

      try {
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
                text += frame.delta;
                yield { content: buildParts() };
                break;
              case 'reasoning-delta':
                reasoning += frame.delta;
                yield { content: buildParts() };
                break;
              case 'error':
                throw new Error(frame.errorText || 'The AI service is temporarily unavailable.');
              // Structural only — the parts are rebuilt from accumulated text
              // on every delta and once more when the stream ends.
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
      } catch (err) {
        if (abortSignal.aborted) return;
        throw err;
      }

      yield { content: buildParts() };
    },
  };
}

export function useRumbleChatRuntime(initialMessages: ThreadMessageLike[]) {
  const chatIdRef = useRef<string | undefined>(localStorage.getItem(CHAT_ID_STORAGE_KEY) ?? undefined);
  const adapterRef = useRef<ChatModelAdapter>(undefined);
  if (!adapterRef.current) {
    adapterRef.current = createAdapter(chatIdRef);
  }
  return useLocalRuntime(adapterRef.current, { initialMessages });
}
