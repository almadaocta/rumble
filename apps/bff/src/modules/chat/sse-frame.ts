import type { Specialist } from '../claude/model-config.js';

/**
 * The chat stream's wire contract.
 *
 * Declared, rather than left as `unknown` on the server and an all-optional
 * `{ type?: string; delta?: string }` on the client. Described that way neither
 * side type-checks what the other sent: a frame with a misspelled `type`, or a
 * `text-delta` that forgot its `delta`, compiles on the server and is silently
 * ignored by the client — the athlete just sees a reply with a piece missing.
 *
 * apps/web mirrors this union in src/lib/api-types.ts, the same way it mirrors
 * the REST payloads: the two apps build independently and there is no shared
 * package. Changing a frame here means changing it there.
 */
export type SseFrame =
  /** Opens the stream and tells the client which chat the turn belongs to. */
  | { type: 'start'; id: string }
  /** Opens a visible block — text, or a run of tool progress lines. */
  | { type: 'start-step' }
  | { type: 'text-delta'; delta: string }
  /** Tool progress, rendered as the collapsed "thinking" section. */
  | { type: 'reasoning-delta'; delta: string }
  /**
   * A specialist's full consult answer, in their own voice — rendered as its
   * own card, distinct from the orchestrator's text around it. Sent once a
   * consult_specialist tool call resolves; the short "Consulting X" line in
   * reasoning-delta is the in-flight indicator leading up to this.
   */
  | { type: 'specialist-message'; specialist: Specialist; text: string }
  /**
   * Two specialists were consulted in the same round and directly
   * contradicted each other. Rendered as its own small card, distinct from
   * (and shorter than) a specialist-message — the full arbitration reasoning
   * (why this app ranks domains the way it does) stays server-side; this is
   * just enough for the athlete to see the disagreement was noticed and how
   * it resolved. Sent per contradiction, before the orchestrator's next-round
   * text — which was itself instructed (orchestrator.md) to defer to and
   * cite this resolution rather than re-explain the disagreement.
   */
  | { type: 'contradiction-notice'; domains: [Specialist, Specialist]; chosenDomain: Specialist; oneLineReason: string }
  | { type: 'finish-step' }
  | { type: 'finish'; usage?: unknown }
  | { type: 'error'; errorText: string };
