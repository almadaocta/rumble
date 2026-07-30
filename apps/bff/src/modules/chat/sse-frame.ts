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
  | { type: 'finish-step' }
  | { type: 'finish'; usage?: unknown }
  | { type: 'error'; errorText: string };
