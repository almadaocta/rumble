# Token Optimization — Design Spec

**Date:** 2026-08-01
**Status:** Approved

---

## Problem

A token audit of the codebase identified six concrete inefficiencies across the chat pipeline. None involve the .fit file analysis (already well-optimized — Claude never sees raw streams). All six are in how tool results, conversation history, and tool payloads are handled.

---

## Changes in Scope

### 1. Fix message compressor AND → OR logic

**File:** `apps/bff/src/modules/chat/message-compressor.ts` lines 62–63

**Current behavior:** Trims conversation history only when BOTH `totalTokens > 120,000` AND `pairStarts.length > 10`. A session with 4 tool-heavy turns accumulating 80k+ token history is never trimmed.

**Fix:** Change to OR — trim when either condition is exceeded.

```typescript
// Before
if (totalTokens <= MAX_TOKENS) return messages;
if (pairStarts.length <= KEEP_RECENT_PAIRS) return messages;

// After
if (totalTokens <= MAX_TOKENS && pairStarts.length <= KEEP_RECENT_PAIRS) return messages;
```

**Token impact:** Closes an unbounded growth path for plan-generation sessions.

---

### 2. Strip old tool-result/tool-use pairs from history

**File:** `apps/bff/src/modules/chat/message-compressor.ts`

**Current behavior:** Every `assistant` (tool_use) + `user` (tool_result) message pair from prior turns is replayed verbatim in every subsequent API call. An `analyze_activity` result from turn 3 (up to ~1,500 tokens) is still in the messages array at turn 20.

**Fix:** In `compressMessages`, after keeping the N most recent conversation pairs, also strip `tool_use`/`tool_result` message pairs that fall outside the recency window. Replace them with a stub assistant text message: `[tool result omitted from history]`. This preserves Claude's understanding that a tool was called without replaying the full payload.

**Recency window:** Keep tool pairs from the last `KEEP_RECENT_PAIRS` turns (same constant as the existing logic — currently 10).

**Token impact:** Up to ~2,000 tokens × number of past tool rounds saved per API call in long conversations.

**Safety constraint:** Never strip the tool_use/tool_result pair from the current turn or the immediately preceding turn — only from history beyond the recency window.

---

### 3. Remove implementation fields from `getActivityDetail`

**File:** `apps/bff/src/modules/tools/get-training-data.ts` lines 158–161

**Current behavior:** Uses `.select()` with no column filter, returning all 22 columns including `fitFileUrl`, `externalId`, `source`, `athleteId`, `createdAt` — fields with no meaning to the model.

**Fix:** Add an explicit column projection that excludes implementation fields:

Fields to remove from the result: `fitFileUrl`, `externalId`, `source`, `athleteId`, `createdAt`.

**Token impact:** ~31 tokens per `get_training_data` call with activity detail.

---

### 4. Remove redundant computed fields from `get_training_data`

**File:** `apps/bff/src/modules/tools/get-training-data.ts`

**Current behavior:** Returns both `durationS` (raw seconds) and `durationFormatted` (human string), and both `distanceM` (raw meters) and `distanceKm` (computed km). The model doesn't need both representations.

**Fix:**
- Remove `durationFormatted` — keep `durationS`. Claude can reason from seconds.
- Remove `distanceM` — keep `distanceKm`. Km is the useful unit for a cycling coach.

**Token impact:** ~2 fields × up to 50 activities × ~15 chars ≈ 94 tokens on a full training data call.

---

### 5. Move static Wahoo note from tool result to tool description

**File:** `apps/bff/src/modules/tools/get-body-metrics.ts` line 65

**Current behavior:** The string `"Wahoo does not provide sleep/HRV. Readiness is derived from Training Stress Balance..."` (~146 chars, ~37 tokens) is hardcoded in the tool _result_ — uncached, resent on every call.

**Fix:** Move this string to the `description` field of `get_body_metrics` in `tool-registry.ts`. Tool descriptions are part of the cached tool block — this becomes free after the first call.

**Token impact:** ~37 tokens saved per `get_body_metrics` call (uncached → cached).

---

### 6. Add token optimization section to README

**File:** `README.md`

Add a new top-level section `## Token budget` after the existing "Three decisions worth defending" section. Document:

- What is cached and why (system prompt, tool schemas, specialist KBs)
- The prompt-cache prefix ordering rule (freeze the prefix, vary content last)
- The message compressor and when it fires
- The tool-result history stripping strategy
- The field projection discipline (no implementation fields in tool results)
- The downsampled data cap (120 points max, single-lap only by default)
- The 8,000-char hard cap on tool results

This makes the token strategy legible to anyone reading the codebase — and keeps it honest as new tools are added.

---

## Out of Scope

- Specialist KB conditional loading (would break the cached-prefix invariant; the whole-library approach is intentional and documented in the README)
- Tool description wording compression (diminishing returns, ~50–100 tokens, high fragility risk)
- `get_training_data` default limit reduction (requires Claude to pass explicit `limit: 1` — needs prompt engineering, not just code)

---

## Architecture Constraints

- All changes must preserve the existing `ToolOutcome { ok: boolean }` discriminated union shape
- The `messages` array mutation in `message-compressor.ts` must never touch the current turn's messages
- Column projections in Drizzle must use `.select({})` object syntax, not raw SQL
- The README section should match the voice and style of the existing "Three decisions worth defending" section — candid, specific, quantified

---

## Files Changed

| File | Change |
|---|---|
| `apps/bff/src/modules/chat/message-compressor.ts` | AND → OR fix + tool-pair stripping |
| `apps/bff/src/modules/tools/get-training-data.ts` | Remove implementation fields + redundant computed fields |
| `apps/bff/src/modules/tools/get-body-metrics.ts` | Remove static Wahoo note from result |
| `apps/bff/src/modules/tools/tool-registry.ts` | Add Wahoo note to `get_body_metrics` description |
| `README.md` | Add `## Token budget` section |

---

## Success Criteria

- `pnpm typecheck` passes
- `pnpm test` passes
- A 20-turn conversation with tool calls does not replay tool-result payloads beyond the recency window
- `get_training_data` result JSON contains no `fitFileUrl`, `externalId`, `source`, `athleteId`, `createdAt`, `durationFormatted`, or `distanceM` fields
- `get_body_metrics` result JSON contains no static Wahoo note string
- README `## Token budget` section exists and covers all six strategies
