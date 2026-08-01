# Token Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce token waste across the chat pipeline via six targeted changes: compressor logic fix, tool-result history stripping, field projection on activity detail, redundant field removal from training data, moving static note from result to tool description, and a README token budget section.

**Architecture:** All changes are surgical — no new files, no new abstractions. The compressor grows one new function. The tool handlers lose fields. The README gains one section. Tests are added/updated in existing test files.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest, Express BFF (`apps/bff/src`)

---

## Task 1: Fix AND → OR in message compressor

**Files:**
- Modify: `apps/bff/src/modules/chat/message-compressor.ts:62-63`
- Test: `apps/bff/src/modules/chat/message-compressor.test.ts`

- [ ] **Step 1: Add a failing test for the AND bug**

Open `apps/bff/src/modules/chat/message-compressor.test.ts` and add this test inside the `describe('compressMessages')` block, after the existing tests:

```typescript
it('trims when token budget is exceeded even with few turns', () => {
  // 3 turns, each with a massive message — well under KEEP_RECENT_PAIRS=10
  // but blows the 120k token budget. The AND bug lets this through untrimmed.
  const HUGE = 'x'.repeat(200_000); // ~50k tokens each, 3 × 50k = 150k > 120k
  const messages = [
    userTurn(`q1 ${HUGE}`),
    assistantText('a1'),
    userTurn(`q2 ${HUGE}`),
    assistantText('a2'),
    userTurn(`q3 ${HUGE}`),
    assistantText('a3'),
  ];
  const result = compressMessages(messages);
  // Should be trimmed — not equal to the original
  expect(result.length).toBeLessThan(messages.length);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter bff test message-compressor
```

Expected: FAIL — `expect(result.length).toBeLessThan(messages.length)` — the current AND logic returns early without trimming.

- [ ] **Step 3: Fix the AND condition**

In `apps/bff/src/modules/chat/message-compressor.ts`, replace lines 62–63:

```typescript
// Before
  if (totalTokens <= MAX_TOKENS) return messages;
  if (pairStarts.length <= KEEP_RECENT_PAIRS) return messages;
```

with:

```typescript
  if (totalTokens <= MAX_TOKENS && pairStarts.length <= KEEP_RECENT_PAIRS) return messages;
```

- [ ] **Step 4: Run all compressor tests**

```bash
pnpm --filter bff test message-compressor
```

Expected: All tests pass including the new one.

- [ ] **Step 5: Commit**

```bash
git add apps/bff/src/modules/chat/message-compressor.ts apps/bff/src/modules/chat/message-compressor.test.ts
git commit -m "fix: trim conversation history when either token OR turn limit exceeded"
```

---

## Task 2: Strip old tool-result/tool-use pairs from history

**Files:**
- Modify: `apps/bff/src/modules/chat/message-compressor.ts`
- Test: `apps/bff/src/modules/chat/message-compressor.test.ts`

The compressor already trims at user-turn boundaries. After trimming, any `tool_use` + `tool_result` pairs that survive in history but fall outside the most recent turns keep replaying large payloads. This task replaces their content with a stub.

- [ ] **Step 1: Add a failing test for tool-pair stubbing**

Add this to the `describe('compressMessages')` block in `message-compressor.test.ts`:

```typescript
it('stubs out tool-result content in older turns after trimming', () => {
  // Build a conversation where old turns have large tool results.
  // After trimming, those old tool-result payloads should be replaced,
  // not replayed verbatim.
  const HUGE = 'x'.repeat(60_000);
  const messages = buildConversation(20, 2);
  const result = compressMessages(messages);

  // None of the surviving tool_result blocks should contain the large payload
  // from old turns (they've been stubbed). Recent turns' tool results are fine.
  const toolResultContents = result
    .filter((m) => !isToolResultTurn_TEST(m) === false)
    .flatMap((m) => {
      if (typeof m.content === 'string') return [];
      return m.content
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b as { content?: string }).content ?? '');
    });

  // The stubs should contain the placeholder text
  const hasStubs = toolResultContents.some((c) => c.includes('[tool result omitted]'));
  expect(hasStubs).toBe(true);
});
```

We also need to export `isToolResultTurn` for the test (or just re-implement inline). Actually — let's test the observable behavior instead: that old tool-result messages are shorter after compression. Add this simpler test instead (replace the above):

```typescript
it('stubs out large tool results from turns outside the recency window', () => {
  const PAYLOAD = 'x'.repeat(8000); // simulate a big tool result
  const messages: ChatMessage[] = [];

  // Build 15 turns — 5 recent + 10 old that should be stubbed
  for (let i = 0; i < 15; i++) {
    const id = `toolu_${i}`;
    messages.push(userTurn(`question ${i} ${'y'.repeat(60_000)}`));
    messages.push(assistantToolUse(id));
    messages.push(toolResult(id, PAYLOAD));
    messages.push(assistantText(`answer ${i}`));
  }

  const result = compressMessages(messages);

  // Old tool result blocks should NOT contain the large payload
  const toolResultMessages = result.filter((m) => {
    if (typeof m.content === 'string') return false;
    return m.content.some((b) => b.type === 'tool_result');
  });

  // At least some tool_result messages should have been stubbed
  const stubbedCount = toolResultMessages.filter((m) => {
    if (typeof m.content === 'string') return false;
    return m.content.some(
      (b) => b.type === 'tool_result' && (b as { content?: string }).content === '[tool result omitted]',
    );
  }).length;

  expect(stubbedCount).toBeGreaterThan(0);

  // No orphaned tool results
  expect(hasOrphanedToolResult(result)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter bff test message-compressor
```

Expected: FAIL — stubbed count is 0, no stubbing implemented yet.

- [ ] **Step 3: Implement tool-pair stubbing in the compressor**

In `apps/bff/src/modules/chat/message-compressor.ts`, add a helper function after `findUserTurnBoundaries` and update `compressMessages`:

```typescript
/**
 * Replace the content of tool_result blocks in messages that are NOT within
 * the recent window. This prevents large tool payloads from old turns from
 * being replayed in every subsequent API call.
 *
 * We stub the content rather than removing the message entirely — the
 * tool_use/tool_result pair must stay structurally intact or the API rejects
 * the conversation. The stub is short enough that it's nearly free.
 */
function stubOldToolResults(messages: ChatMessage[], cutoffIdx: number): ChatMessage[] {
  return messages.map((m, i) => {
    if (i >= cutoffIdx) return m; // recent — leave untouched
    if (typeof m.content === 'string') return m;
    const hasToolResult = m.content.some((b) => b.type === 'tool_result');
    if (!hasToolResult) return m;

    return {
      ...m,
      content: m.content.map((b) => {
        if (b.type !== 'tool_result') return b;
        return { ...b, content: '[tool result omitted]' };
      }),
    };
  });
}
```

Then update `compressMessages` to call it. Replace the full function body:

```typescript
export function compressMessages(messages: ChatMessage[]): ChatMessage[] {
  const totalTokens = estimateTokens(messages);
  const pairStarts = findUserTurnBoundaries(messages);

  log.debug('Context size', {
    messages: messages.length,
    userTurns: pairStarts.length,
    estimatedTokens: totalTokens,
  });

  if (totalTokens <= MAX_TOKENS && pairStarts.length <= KEEP_RECENT_PAIRS) return messages;

  const cutoffIdx = pairStarts[Math.max(0, pairStarts.length - KEEP_RECENT_PAIRS)];
  const trimmed = messages.slice(cutoffIdx);
  const stubbed = stubOldToolResults(messages, cutoffIdx);
  // Use stubbed (full length) if we're only over the turn count,
  // use trimmed if we're over the token budget.
  const result = totalTokens > MAX_TOKENS ? trimmed : stubbed;
  const newTokens = estimateTokens(result);

  log.info('Trimmed conversation history', {
    messagesBefore: messages.length,
    messagesAfter: result.length,
    tokensBefore: totalTokens,
    tokensAfter: newTokens,
    keptUserTurns: KEEP_RECENT_PAIRS,
  });

  return result;
}
```

- [ ] **Step 4: Run all compressor tests**

```bash
pnpm --filter bff test message-compressor
```

Expected: All tests pass — no orphaned tool results, stubs present, recent content preserved.

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
pnpm --filter bff test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/bff/src/modules/chat/message-compressor.ts apps/bff/src/modules/chat/message-compressor.test.ts
git commit -m "feat: stub old tool-result payloads in conversation history to save tokens"
```

---

## Task 3: Strip implementation fields from `getActivityDetail`

**Files:**
- Modify: `apps/bff/src/modules/tools/get-training-data.ts:157-161`

`getActivityDetail` currently does `.select()` with no projection, returning all 22 columns including `fitFileUrl`, `externalId`, `source`, `athleteId`, `createdAt` — fields the model has no use for.

- [ ] **Step 1: Write a failing test**

There is no dedicated test file for `get-training-data.ts`. Check if `tenant-isolation.test.ts` covers it:

```bash
grep -n 'getActivityDetail\|get_training_data\|activity_id' apps/bff/src/modules/tools/tenant-isolation.test.ts
```

Add a test to `apps/bff/src/modules/tools/tenant-isolation.test.ts` that verifies the stripped fields are absent. First read the file to understand the test setup pattern, then add:

```typescript
it('getTrainingData activity detail does not expose implementation fields', async () => {
  // Use the existing test DB seeding pattern from this file
  const { athleteId } = await seedAthlete(db);
  const activityId = await seedActivity(db, athleteId);

  const result = await getTrainingData({ activity_id: activityId }, athleteId);

  expect(result.ok).toBe(true);
  // Implementation fields must not be present
  expect(result).not.toHaveProperty('fitFileUrl');
  expect(result).not.toHaveProperty('externalId');
  expect(result).not.toHaveProperty('source');
  expect(result).not.toHaveProperty('athleteId');
  expect(result).not.toHaveProperty('createdAt');
  // Redundant computed fields must not be present
  expect(result).not.toHaveProperty('durationFormatted');
  expect(result).not.toHaveProperty('distanceM');
});
```

> **Note:** Read `apps/bff/src/modules/tools/tenant-isolation.test.ts` in full before adding this test to understand the exact `seedAthlete` / `seedActivity` helper signatures used there. Mirror the pattern exactly.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter bff test tenant-isolation
```

Expected: FAIL — result contains `fitFileUrl`, `externalId`, etc.

- [ ] **Step 3: Add explicit column projection to `getActivityDetail`**

In `apps/bff/src/modules/tools/get-training-data.ts`, replace lines 157–161:

```typescript
// Before
  const [activity] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.athleteId, athleteId)))
    .limit(1);
```

with:

```typescript
  const [activity] = await db
    .select({
      id: activities.id,
      type: activities.type,
      name: activities.name,
      startedAt: activities.startedAt,
      durationS: activities.durationS,
      avgPower: activities.avgPower,
      normPower: activities.normPower,
      maxPower: activities.maxPower,
      avgHr: activities.avgHr,
      maxHr: activities.maxHr,
      avgCadence: activities.avgCadence,
      tss: activities.tss,
      intensityFactor: activities.intensityFactor,
      distanceM: activities.distanceM,
      elevationM: activities.elevationM,
      calories: activities.calories,
    })
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.athleteId, athleteId)))
    .limit(1);
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter bff test tenant-isolation
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bff/src/modules/tools/get-training-data.ts apps/bff/src/modules/tools/tenant-isolation.test.ts
git commit -m "fix: strip implementation fields from getActivityDetail tool result"
```

---

## Task 4: Remove redundant computed fields from `get_training_data` list response

**Files:**
- Modify: `apps/bff/src/modules/tools/get-training-data.ts:94-100`

The list query returns both `durationS` + `durationFormatted` and both `distanceM` + `distanceKm`. Claude only needs `durationS` and `distanceKm`.

- [ ] **Step 1: Add a failing test**

Add to `apps/bff/src/modules/tools/tenant-isolation.test.ts` (or the test file used in Task 3):

```typescript
it('getTrainingData list response omits redundant computed fields', async () => {
  const { athleteId } = await seedAthlete(db);
  await seedActivity(db, athleteId);

  const result = await getTrainingData({ days: 30 }, athleteId);

  expect(result.ok).toBe(true);
  const acts = result.activities as Record<string, unknown>[];
  expect(acts.length).toBeGreaterThan(0);

  // Redundant fields must not be present on list items
  expect(acts[0]).not.toHaveProperty('durationFormatted');
  expect(acts[0]).not.toHaveProperty('distanceM');
  // These should still be present
  expect(acts[0]).toHaveProperty('durationS');
  expect(acts[0]).toHaveProperty('distanceKm');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter bff test tenant-isolation
```

Expected: FAIL — `durationFormatted` and `distanceM` are present.

- [ ] **Step 3: Remove redundant fields from list query**

In `apps/bff/src/modules/tools/get-training-data.ts`, update the `recentActivities` select to remove `distanceM` and update the map:

First, remove `distanceM` from the select projection (lines 64–86). Change:

```typescript
      distanceM: activities.distanceM,
```

to remove that line entirely. The select block becomes:

```typescript
  const recentActivities = await db
    .select({
      id: activities.id,
      type: activities.type,
      name: activities.name,
      startedAt: activities.startedAt,
      durationS: activities.durationS,
      avgPower: activities.avgPower,
      normPower: activities.normPower,
      maxPower: activities.maxPower,
      avgHr: activities.avgHr,
      maxHr: activities.maxHr,
      avgCadence: activities.avgCadence,
      tss: activities.tss,
      intensityFactor: activities.intensityFactor,
      distanceKm: activities.distanceM,
      elevationM: activities.elevationM,
      calories: activities.calories,
    })
    .from(activities)
    .where(and(...conditions))
    .orderBy(desc(activities.startedAt))
    .limit(maxLimit);
```

Then update the `.map()` at lines 94–100. Replace:

```typescript
    activities: recentActivities.map((a) => ({
      ...a,
      durationFormatted: formatDuration(a.durationS),
      // `!= null`: a turbo session records 0 m, which is a measurement, not a
      // gap. Truthiness reports it to the coach as unknown distance.
      distanceKm: a.distanceM != null ? (Number(a.distanceM) / 1000).toFixed(1) : null,
    })),
```

with:

```typescript
    activities: recentActivities.map((a) => ({
      ...a,
      // `!= null`: a turbo session records 0 m, which is a measurement, not a
      // gap. Truthiness reports it to the coach as unknown distance.
      distanceKm: a.distanceKm != null ? (Number(a.distanceKm) / 1000).toFixed(1) : null,
    })),
```

Also remove the `formatDuration` import if it's now unused — check if it's still used in `getActivityDetail` below (it is, for laps). Leave the import.

- [ ] **Step 4: Remove redundant fields from `getActivityDetail` result**

In `getActivityDetail` (lines 165–169), replace:

```typescript
  const result: Record<string, unknown> = {
    ...activity,
    durationFormatted: formatDuration(activity.durationS),
    distanceKm: activity.distanceM != null ? (Number(activity.distanceM) / 1000).toFixed(1) : null,
  };
```

with:

```typescript
  const result: Record<string, unknown> = {
    ...activity,
    distanceKm: activity.distanceM != null ? (Number(activity.distanceM) / 1000).toFixed(1) : null,
  };
```

And remove `distanceM` from the result (it's in `activity` spread — we already stripped it from the select in Task 3, so the spread won't include it). Verify the column projection from Task 3 includes `distanceM` so we can compute `distanceKm`, then exclude it from the spread by being explicit. Update the `getActivityDetail` result construction:

```typescript
  const result: Record<string, unknown> = {
    id: activity.id,
    type: activity.type,
    name: activity.name,
    startedAt: activity.startedAt,
    durationS: activity.durationS,
    avgPower: activity.avgPower,
    normPower: activity.normPower,
    maxPower: activity.maxPower,
    avgHr: activity.avgHr,
    maxHr: activity.maxHr,
    avgCadence: activity.avgCadence,
    tss: activity.tss,
    intensityFactor: activity.intensityFactor,
    distanceKm: activity.distanceM != null ? (Number(activity.distanceM) / 1000).toFixed(1) : null,
    elevationM: activity.elevationM,
    calories: activity.calories,
  };
```

- [ ] **Step 5: Run all tests**

```bash
pnpm --filter bff test
```

Expected: All tests pass.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add apps/bff/src/modules/tools/get-training-data.ts apps/bff/src/modules/tools/tenant-isolation.test.ts
git commit -m "fix: remove redundant durationFormatted and distanceM from training data tool results"
```

---

## Task 5: Move static Wahoo note from tool result to tool description

**Files:**
- Modify: `apps/bff/src/modules/tools/get-body-metrics.ts:65`
- Modify: `apps/bff/src/modules/tools/tool-registry.ts:178-179`

The note `"Wahoo does not provide sleep/HRV..."` is currently hardcoded in the tool *result* (uncached, paid on every call). The tool description at line 179 already has a shorter version. We need to remove the note from the result entirely — the description already covers it.

- [ ] **Step 1: Add a failing test**

Add to `apps/bff/src/modules/tools/tenant-isolation.test.ts`:

```typescript
it('getBodyMetrics result does not contain the static Wahoo note', async () => {
  const { athleteId } = await seedAthlete(db);

  const result = await getBodyMetrics({}, athleteId);

  expect(result.ok).toBe(true);
  const readiness = result.readiness as Record<string, unknown>;
  expect(readiness).not.toHaveProperty('note');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter bff test tenant-isolation
```

Expected: FAIL — `readiness.note` exists.

- [ ] **Step 3: Remove the note from the tool result**

In `apps/bff/src/modules/tools/get-body-metrics.ts`, remove line 65. The `readiness` object becomes:

```typescript
    readiness: {
      source: 'tsb',
      form_status: formStatus,
      tsb,
      ctl: num(latest?.ctl),
      atl: num(latest?.atl),
      ramp_rate: num(latest?.rampRate),
      ramp_assessment: rampAssessment,
    },
```

- [ ] **Step 4: Verify the tool description already covers it**

Read `apps/bff/src/modules/tools/tool-registry.ts` lines 175–184. The description at line 179 already says:
`"Note: Wahoo does not provide sleep or HRV data — readiness is derived from training load balance."`

No change needed to the registry.

- [ ] **Step 5: Run all tests**

```bash
pnpm --filter bff test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/bff/src/modules/tools/get-body-metrics.ts apps/bff/src/modules/tools/tenant-isolation.test.ts
git commit -m "fix: move static Wahoo HRV note from tool result to tool description (cached)"
```

---

## Task 6: Add Token Budget section to README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the section**

Open `README.md`. After the `### 3. The auth seam` section (line 119) and before `---` (line 119), insert the following new top-level section. Add it after the `---` on line 119 and before `## The knowledge base` on line 121:

```markdown
## Token budget

Every API call to Claude carries three categories of tokens: **cached** (paid once per cache TTL), **uncached static** (the same every call, but not cached), and **uncached dynamic** (varies per turn). Understanding which category each input falls into is what keeps cost predictable at scale.

### What's cached

| Input | Cache strategy | ~Tokens |
| --- | --- | --- |
| Orchestrator system prompt (`prompts/orchestrator.md`) | Ephemeral prefix — first block sent to Claude, byte-identical every call | ~503 |
| All 15 tool schemas | Ephemeral on last tool in array — caches the whole block | ~3,200 |
| Specialist persona + full KB | Ephemeral prefix — memoised at startup, sorted deterministically | ~9k–14k |

Caching is a **prefix match** — one changed byte invalidates everything after it. The ordering rule: freeze the static prefix, put anything that varies after the last cache breakpoint. This is why the slim preamble (which has a live timestamp) is a separate block placed *after* the cached system prompt.

Specialist KBs are sent in full rather than retrieved via RAG. The largest library is ~14k tokens — 7% of Haiku's context window. At that size, whole-library cached prefills cost roughly the same as four retrieved chunks uncached, with no relevance floor, no embedding pipeline, and no sync step. See "No vector database" above for the measurement that justified this.

### What the compressor does

Conversation history is the only unbounded input. `message-compressor.ts` trims it when *either* the token estimate exceeds 120k *or* the turn count exceeds 10 recent pairs — whichever comes first. The trim point lands on a real user turn boundary (never mid-tool-round, which would orphan a `tool_result` and cause an API rejection).

Beyond trimming, old `tool_use`/`tool_result` pairs that fall outside the recency window have their payloads stubbed to `[tool result omitted]`. A tool result from turn 3 is still structurally present (so Claude knows a tool was called) but costs ~5 tokens instead of ~2,000.

### Tool result discipline

Tool results are capped at 8,000 characters in `chat.stream.ts` before being sent to Claude. Within that cap, results follow these rules to avoid waste:

- **No implementation fields.** `fitFileUrl`, `externalId`, `source`, `athleteId`, `createdAt` are never included in tool results — they're database internals with no meaning to the model.
- **No redundant representations.** Duration is `durationS` (raw seconds), not `durationS` + `durationFormatted`. Distance is `distanceKm`, not `distanceKm` + `distanceM`.
- **Static notes belong in tool descriptions, not results.** Tool descriptions are part of the cached tool block. A note that appears in a tool *result* is paid on every uncached call; the same note in the tool *description* is paid once per cache TTL.

### .fit file analysis token footprint

The raw per-second streams (3,600–18,000+ numbers for a 1–5 hr ride) are never sent to Claude. `analyze-activity.ts` runs all computation in Node.js — NP, IF, zones, drift, power/HR by thirds — and returns ~250–350 tokens of pre-computed scalars. The optional downsampled trend arrays are capped at 120 points per channel and only auto-included for single-lap activities.
```

- [ ] **Step 2: Verify the README renders correctly**

```bash
# Check for obvious markdown issues — unmatched backticks, broken tables
cat README.md | grep -c '|'
```

Expected: a reasonable count of pipe characters (the tables exist).

- [ ] **Step 3: Run full test suite one final time**

```bash
pnpm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add Token budget section to README"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| AND → OR compressor fix | Task 1 |
| Tool-result history stripping | Task 2 |
| Strip implementation fields from activity detail | Task 3 |
| Remove redundant fields (durationFormatted, distanceM) | Task 4 |
| Move static Wahoo note to tool description | Task 5 |
| README token optimization section | Task 6 |

All six spec requirements covered. ✓

**Placeholder scan:** No TBDs, no "implement later", no "add appropriate error handling" — all steps contain actual code. ✓

**Type consistency:**
- `getActivityDetail` column projection in Task 3 includes `distanceM` so Task 4's `distanceKm` computation has a source. ✓
- `stubOldToolResults` in Task 2 uses `ChatMessage` from the existing import. ✓
- `getBodyMetrics` in Task 5 removes only the `note` field — all other fields stay intact. ✓
