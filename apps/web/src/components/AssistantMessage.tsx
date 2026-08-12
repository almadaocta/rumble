import { AssistantMessage as AssistantMessageParts, BranchPicker, AssistantActionBar } from '@assistant-ui/react-ui';
import { useMessage, type ReasoningMessagePartComponent } from '@assistant-ui/react';
import { Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AvatarCircle } from '@/components/shared';
import { SPECIALIST_META, isSpecialist } from '@/lib/specialists';
import { speakerOf, isContradictionNotice } from '@/lib/chat-runtime';

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

/**
 * assistant-ui's default avatar is a plain gray circle with a bare "A"
 * fallback shared by every assistant message — there's no per-message hook
 * for it. This reads which speaker actually produced *this* message
 * (chat-runtime.ts tags every assistant message with metadata.custom.speaker)
 * and picks a matching AvatarCircle: the orchestrator's own red "R", or the
 * consulted specialist's color + initial when this message is their reply.
 *
 * className reapplies assistant-ui's own grid-positioning rules
 * (.aui-avatar-root / .aui-assistant-avatar), which target that selector to
 * place the avatar in column 1 of the message grid — see the sibling content
 * wrapper below for why a specialist's name label needs the same treatment.
 */
function SpeakerAvatar() {
  const speaker = useMessage((m) => speakerOf(m.metadata));
  if (isSpecialist(speaker)) {
    const meta = SPECIALIST_META[speaker];
    return (
      <AvatarCircle
        initial={meta.initial}
        color={meta.color}
        foreground={meta.colorForeground}
        className="aui-avatar-root aui-assistant-avatar"
      />
    );
  }
  return (
    <AvatarCircle
      initial="R"
      color="var(--color-primary)"
      foreground="var(--color-primary-foreground)"
      className="aui-avatar-root aui-assistant-avatar"
    />
  );
}

/** Name + icon above a specialist's reply. Orchestrator messages show nothing here — their avatar alone is identity enough. */
function SpeakerLabel() {
  const speaker = useMessage((m) => speakerOf(m.metadata));
  if (!isSpecialist(speaker)) return null;
  const meta = SPECIALIST_META[speaker];
  const Icon = meta.icon;
  return (
    <div className="mb-1 flex items-center gap-1.5 text-xs font-medium" style={{ color: meta.color }}>
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
    </div>
  );
}

/**
 * A contradiction-notice's avatar: deliberately neutral, not one more
 * speaker in the roster — this message isn't any specialist's or the
 * orchestrator's own voice, just a short note about how two of them were
 * reconciled.
 */
function NoticeAvatar() {
  return (
    <AvatarCircle
      initial="!"
      color="var(--color-muted)"
      foreground="var(--color-muted-foreground)"
      className="aui-avatar-root aui-assistant-avatar"
    />
  );
}

export function AssistantMessage() {
  const notice = useMessage((m) => isContradictionNotice(m.metadata));

  return (
    <AssistantMessageParts.Root>
      {notice ? <NoticeAvatar /> : <SpeakerAvatar />}
      {/*
        assistant-ui's CSS grid places .aui-assistant-message-content at a
        fixed cell (column 2, row 1) as a direct child of Root. A label needs
        to sit above that same content, in that same cell, so this wrapper
        takes over the cell's placement via inline style (no extra class to
        keep in sync with the library's own) and stacks label + content
        inside it with normal block flow. min-w-0 matters in a grid cell —
        without it, an unbroken long word/URL pushes the column wider instead
        of wrapping.
      */}
      <div className="min-w-0" style={{ gridColumn: '2 / span 2', gridRow: '1' }}>
        {notice ? (
          // Deliberately smaller and muted, not a normal chat bubble — the
          // full arbitration reasoning stays server-side (see sse-frame.ts);
          // this is just enough for the athlete to see the disagreement was
          // noticed and how it resolved.
          <div className="pt-2 text-xs text-muted-foreground italic leading-relaxed">
            <AssistantMessageParts.Content />
          </div>
        ) : (
          <>
            <SpeakerLabel />
            <AssistantMessageParts.Content components={{ Reasoning }} />
          </>
        )}
      </div>
      <BranchPicker />
      <AssistantActionBar />
    </AssistantMessageParts.Root>
  );
}
