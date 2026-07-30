import { AssistantMessage as AssistantMessageParts, BranchPicker, AssistantActionBar } from '@assistant-ui/react-ui';
import type { ReasoningMessagePartComponent } from '@assistant-ui/react';
import { Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

// The orchestrator's tool-consultation status ("Consulting nutritionist" /
// "↳ summary") streams in as a reasoning part. assistant-ui's built-in
// Reasoning renderer is a no-op (`() => null`) by design, and react-ui's
// <Thread> config has no slot to override just that — so this rebuilds the
// assistant message from react-ui's own exported sub-parts, adding the one
// piece it's missing.
//
// `status.type` is the message's own running/complete state (our protocol
// has no distinct "reasoning finished" signal, only "the whole turn is
// done") — pulse for as long as anything in the turn is still in flight.
const Reasoning: ReasoningMessagePartComponent = ({ text, status }) => {
  if (!text) return null;
  const running = status.type === 'running';
  return (
    <div className="mb-2 flex items-start gap-2 text-xs text-muted-foreground italic leading-relaxed">
      <Wrench className={cn('h-3.5 w-3.5 mt-0.5 shrink-0', running && 'animate-pulse')} />
      <span className={cn('whitespace-pre-wrap', running && 'animate-pulse')}>{text}</span>
    </div>
  );
};

export function AssistantMessage() {
  return (
    <AssistantMessageParts.Root>
      <AssistantMessageParts.Avatar />
      <AssistantMessageParts.Content components={{ Reasoning }} />
      <BranchPicker />
      <AssistantActionBar />
    </AssistantMessageParts.Root>
  );
}
