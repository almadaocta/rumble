/**
 * The shape every tool handler returns.
 *
 * All 15 report through `ok`, so "did this work?" is one question rather than a
 * per-tool convention Claude has to infer from each payload's shape. Distinct
 * from the `error` field on `ToolResult` in tool.executor.ts: `ok: false` means
 * the tool ran and declined, a top-level `error` means the handler threw.
 */

/** A tool that did the thing. The payload is whatever that tool reports. */
export type ToolSuccess = {
  ok: true;
  [key: string]: unknown;
};

/** A tool that ran and declined, with a reason Claude can act on. */
export type ToolFailure = {
  ok: false;
  error: string;
  [key: string]: unknown;
};

/**
 * A discriminated union on `ok`, not `{ ok: boolean; error?: string }`.
 *
 * With an optional `error`, a caller can read `outcome.error` on a success
 * (always undefined) and a handler can return `{ ok: false }` with no reason at
 * all — a decline the model can only relay to the athlete as a bare failure.
 * Narrowing on `ok` makes `error` available exactly when it means something and
 * required exactly when it is the only thing that does.
 */
export type ToolOutcome = ToolSuccess | ToolFailure;
