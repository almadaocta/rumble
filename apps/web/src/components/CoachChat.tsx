import { useState, useEffect } from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { Thread, makeMarkdownText } from '@assistant-ui/react-ui';
import { useRumbleChatRuntime, loadInitialMessages } from '@/lib/chat-runtime';
import { AssistantMessage } from '@/components/AssistantMessage';
import type { ThreadMessageLike } from '@assistant-ui/react';
import { Loader2 } from 'lucide-react';

const MarkdownText = makeMarkdownText();

interface CoachChatProps {
  firstName: string;
  suggestions: { prompt: string }[];
}

function ChatInner({ firstName, suggestions, initialMessages }: CoachChatProps & { initialMessages: ThreadMessageLike[] }) {
  const runtime = useRumbleChatRuntime(initialMessages);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        welcome={{
          message: `Hey ${firstName} — your coaching team, in one conversation. Ask me anything.`,
          suggestions: suggestions.map((s) => ({ prompt: s.prompt })),
        }}
        assistantMessage={{ components: { Text: MarkdownText } }}
        components={{ AssistantMessage }}
      />
    </AssistantRuntimeProvider>
  );
}

export function CoachChat(props: CoachChatProps) {
  const [initialMessages, setInitialMessages] = useState<ThreadMessageLike[] | null>(null);

  useEffect(() => {
    loadInitialMessages().then(setInitialMessages);
  }, []);

  if (initialMessages === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <ChatInner {...props} initialMessages={initialMessages} />;
}
