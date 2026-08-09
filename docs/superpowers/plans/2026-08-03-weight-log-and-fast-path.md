# Weight Log Table + Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `weight_logs` table to record daily weigh-ins with history, a `log_weight` orchestrator tool, and a fast-path that bypasses Opus for plain weight-report messages.

**Architecture:** New `weight_logs` table (one row per athlete per date, upsert on conflict) mirrors the `nutrition_logs` pattern. A `log_weight` tool handler follows `log-meal.ts` exactly. A `fast-path-weight.ts` module follows `fast-path-meal-log.ts` exactly — Haiku forced tool call, Zod parse, silent fallback. The controller chains the two fast-path checks before falling through to the orchestrator.

**Tech Stack:** Drizzle ORM + SQLite, Zod, Vitest, Anthropic SDK (Haiku forced tool call), TypeScript strict mode.

---

## File map

| Action | Path |
|--------|------|
| **Create** | `apps/bff/drizzle/0003_weight_logs.sql` |
| **Modify** | `apps/bff/drizzle/meta/_journal.json` |
| **Modify** | `apps/bff/src/db/schema.ts` |
| **Create** | `apps/bff/src/modules/tools/log-weight.ts` |
| **Create** | `apps/bff/src/modules/tools/log-weight.test.ts` |
| **Modify** | `apps/bff/src/modules/tools/tool-registry.ts` |
| **Create** | `apps/bff/src/modules/chat/fast-path-weight.ts` |
| **Create** | `apps/bff/src/modules/chat/fast-path-weight.test.ts` |
| **Modify** | `apps/bff/src/modules/chat/chat.controller.ts` |

---

## Task 1: Migration — `weight_logs` table

**Files:**
- Create: `apps/bff/drizzle/0003_weight_logs.sql`
- Modify: `apps/bff/drizzle/meta/_journal.json`

- [ ] **Step 1: Write the migration SQL**

Create `apps/bff/drizzle/0003_weight_logs.sql`:

```sql
CREATE TABLE `weight_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`date` text NOT NULL,
	`weight_kg` real NOT NULL,
	`note` text,
	`source` text NOT NULL DEFAULT 'chat',
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_weight_logs_athlete_date` ON `weight_logs` (`athlete_id`,`date`);
```

- [ ] **Step 2: Register the migration in the journal**

Open `apps/bff/drizzle/meta/_journal.json` and append the new entry:

```json
{
  "version": "7",
  "dialect": "sqlite",
  "entries": [
    {
      "idx": 0,
      "version": "6",
      "when": 1784991394645,
      "tag": "0000_amused_true_believers",
      "breakpoints": true
    },
    {
      "idx": 1,
      "version": "6",
      "when": 1753920000000,
      "tag": "0001_drop_kb_chunks",
      "breakpoints": true
    },
    {
      "idx": 2,
      "version": "6",
      "when": 1753920000001,
      "tag": "0002_calorie_adjustment",
      "breakpoints": true
    },
    {
      "idx": 3,
      "version": "6",
      "when": 1753920000002,
      "tag": "0003_weight_logs",
      "breakpoints": true
    }
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/bff/drizzle/0003_weight_logs.sql apps/bff/drizzle/meta/_journal.json
git commit -m "chore: add weight_logs migration"
```

---

## Task 2: Schema — add `weightLogs` table

**Files:**
- Modify: `apps/bff/src/db/schema.ts`

- [ ] **Step 1: Add the table definition**

Open `apps/bff/src/db/schema.ts`. After the closing `);` of the `nutritionLogs` table (around line 204), insert:

```typescript
export const weightLogs = sqliteTable(
  'weight_logs',
  {
    id: uuidPk(),
    athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
    date: dateCol('date').notNull(),
    weightKg: real('weight_kg').notNull(),
    note: text('note'),
    source: text('source').notNull().default('chat'),
    createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    uniqDate: unique('uq_weight_logs_athlete_date').on(t.athleteId, t.date),
  }),
);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/bff && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/bff/src/db/schema.ts
git commit -m "feat: add weightLogs schema table"
```

---

## Task 3: Tool handler — `log-weight.ts`

**Files:**
- Create: `apps/bff/src/modules/tools/log-weight.ts`

- [ ] **Step 1: Write the failing test first** (see Task 4 — write test before handler)

_(Complete Task 4 Step 1 before returning here.)_

- [ ] **Step 2: Implement the handler**

Create `apps/bff/src/modules/tools/log-weight.ts`:

```typescript
import { z } from 'zod';
import { db } from '../../db/client.js';
import { weightLogs } from '../../db/schema.js';
import { sql } from 'drizzle-orm';
import type { ToolFailure } from './tool-result.js';
import { utcDateString } from '../../lib/format.js';

const LogWeightArgs = z.object({
  weight_kg: z.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().optional(),
});

export type LogWeightSuccess = {
  ok: true;
  id: string;
  date: string;
  weight_kg: number;
  note?: string;
};

/**
 * Upserts a daily weigh-in for the athlete.
 *
 * One row per athlete per date — a second log for the same day replaces the
 * first rather than creating a duplicate. This matches real-world behaviour
 * (athlete weighs themselves, realises they forgot to subtract clothes weight,
 * logs again). The unique index on (athlete_id, date) enforces the constraint
 * at the DB level; the DO UPDATE is the application-level behaviour on conflict.
 */
export async function logWeight(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<LogWeightSuccess | ToolFailure> {
  const { weight_kg, date, note } = LogWeightArgs.parse(args);

  const logDate = date ?? utcDateString();

  const { randomUUID } = await import('node:crypto');

  const [row] = await db
    .insert(weightLogs)
    .values({
      id: randomUUID(),
      athleteId,
      date: logDate,
      weightKg: weight_kg,
      note,
      source: 'chat',
    })
    .onConflictDoUpdate({
      target: [weightLogs.athleteId, weightLogs.date],
      set: {
        weightKg: weight_kg,
        note: note ?? sql`note`,
        source: 'chat',
      },
    })
    .returning();

  return {
    ok: true,
    id: row.id,
    date: row.date,
    weight_kg: row.weightKg,
    note: row.note ?? undefined,
  };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd apps/bff && npx tsc --noEmit
```

Expected: no errors.

---

## Task 4: Tool handler tests — `log-weight.test.ts`

**Files:**
- Create: `apps/bff/src/modules/tools/log-weight.test.ts`
- Test: `apps/bff/src/modules/tools/log-weight.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/bff/src/modules/tools/log-weight.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { migrateTestDb, seedAthlete } from '../../test-utils/test-db.js';
import { db } from '../../db/client.js';
import { weightLogs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logWeight } from './log-weight.js';

describe('logWeight', () => {
  let athleteId: string;
  let otherAthleteId: string;

  beforeAll(async () => {
    migrateTestDb();
    athleteId = await seedAthlete('Test Athlete');
    otherAthleteId = await seedAthlete('Other Athlete');
  });

  it('inserts a weight log and returns the row', async () => {
    const result = await logWeight({ weight_kg: 74.5 }, athleteId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.weight_kg).toBe(74.5);
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.id).toBeTruthy();
  });

  it('accepts an explicit date', async () => {
    const result = await logWeight({ weight_kg: 73.0, date: '2026-01-15' }, athleteId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.date).toBe('2026-01-15');
  });

  it('upserts on same date — replaces weight rather than duplicating', async () => {
    const date = '2026-02-01';
    await logWeight({ weight_kg: 75.0, date }, athleteId);
    const second = await logWeight({ weight_kg: 74.2, date }, athleteId);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.weight_kg).toBe(74.2);

    const rows = await db
      .select()
      .from(weightLogs)
      .where(eq(weightLogs.athleteId, athleteId));
    const dateRows = rows.filter((r) => r.date === date);
    expect(dateRows).toHaveLength(1);
    expect(dateRows[0].weightKg).toBe(74.2);
  });

  it('stores an optional note', async () => {
    const result = await logWeight(
      { weight_kg: 73.8, date: '2026-03-01', note: 'post-race' },
      athleteId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note).toBe('post-race');
  });

  it('is scoped by athleteId — other athlete logs do not appear', async () => {
    await logWeight({ weight_kg: 90.0, date: '2026-04-01' }, otherAthleteId);

    const rows = await db
      .select()
      .from(weightLogs)
      .where(eq(weightLogs.athleteId, athleteId));
    const leaked = rows.find((r) => r.weightKg === 90.0);
    expect(leaked).toBeUndefined();
  });

  it('throws ZodError on missing weight_kg', async () => {
    await expect(logWeight({}, athleteId)).rejects.toThrow();
  });

  it('throws ZodError on non-positive weight', async () => {
    await expect(logWeight({ weight_kg: -1 }, athleteId)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — expect failures (handler not yet implemented)**

```bash
cd /path/to/rumble-v2 && npx vitest run apps/bff/src/modules/tools/log-weight.test.ts
```

Expected: FAIL — `Cannot find module './log-weight.js'`.

- [ ] **Step 3: Go back and implement Task 3 Step 2, then re-run**

```bash
npx vitest run apps/bff/src/modules/tools/log-weight.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/bff/src/modules/tools/log-weight.ts apps/bff/src/modules/tools/log-weight.test.ts
git commit -m "feat: add log_weight tool handler with upsert"
```

---

## Task 5: Register the tool in the tool registry

**Files:**
- Modify: `apps/bff/src/modules/tools/tool-registry.ts`

- [ ] **Step 1: Add the import**

At the top of `tool-registry.ts`, after the `recomputePowerCurve` import (line 16), add:

```typescript
import { logWeight } from './log-weight.js';
```

- [ ] **Step 2: Add the registry entry**

In the `TOOL_REGISTRY` object, after the `log_meal` entry (around line 232), add:

```typescript
log_weight: {
  handler: logWeight,
  label: 'Logging weight',
  description:
    'Record the athlete\'s body weight for today or a specified past date. ' +
    'One entry per day — logging again on the same date replaces the previous value. ' +
    'Does NOT require confirmation — just save what they tell you. ' +
    'Use when the athlete reports their weight, e.g. "I weigh 74 kg" or "weighed in at 73.5 this morning".',
  input_schema: {
    type: 'object',
    properties: {
      weight_kg: {
        type: 'number',
        description: 'Body weight in kilograms.',
      },
      date: {
        type: 'string',
        description: 'ISO date (YYYY-MM-DD). Omit to default to today.',
      },
      note: {
        type: 'string',
        description: 'Optional context, e.g. "post-race", "morning, fasted".',
      },
    },
    required: ['weight_kg'],
  },
},
```

- [ ] **Step 3: Verify TypeScript compiles and existing tests still pass**

```bash
cd apps/bff && npx tsc --noEmit && npx vitest run apps/bff/src/modules/tools/
```

Expected: no type errors, all tool tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/bff/src/modules/tools/tool-registry.ts
git commit -m "feat: register log_weight tool in orchestrator"
```

---

## Task 6: Fast-path handler — `fast-path-weight.ts`

**Files:**
- Create: `apps/bff/src/modules/chat/fast-path-weight.ts`

This mirrors `fast-path-meal-log.ts` structurally — same forced tool call pattern, same Zod guard, same three-layer fallback.

- [ ] **Step 1: Implement the fast path**

Create `apps/bff/src/modules/chat/fast-path-weight.ts`:

```typescript
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import { chat } from '../claude/claude.client.js';
import { z } from 'zod';
import { logWeight, type LogWeightSuccess } from '../tools/log-weight.js';
import { createLogger, describeError } from '../../logger.js';

const log = createLogger('fast-path-weight');

// Weight logging is pure extraction (text → kg), not coaching judgment.
// One cheap Haiku call classifies AND extracts in a single forced tool call.
// Any failure falls through to the full orchestrator.
const CLASSIFY_AND_EXTRACT_TOOL = {
  name: 'classify_weight_log',
  description:
    'Classify whether the message is ONLY reporting a body weight measurement, with nothing else ' +
    'requiring a coaching response (no questions, no other requests). Be conservative — if in doubt, ' +
    'is_weight_log is false. If true, extract the weight fields.',
  input_schema: {
    type: 'object' as const,
    properties: {
      is_weight_log: {
        type: 'boolean',
        description: 'True only if the entire message is just reporting a body weight, nothing else.',
      },
      weight_kg: {
        type: 'number',
        description: 'Body weight in kilograms.',
      },
      date: {
        type: 'string',
        description: 'ISO date YYYY-MM-DD if a specific past date is mentioned. Omit for today.',
      },
      note: {
        type: 'string',
        description: 'Optional context, e.g. "morning", "post-race".',
      },
    },
    required: ['is_weight_log'],
  },
};

const ClassifyResult = z
  .object({
    is_weight_log: z.boolean(),
    weight_kg: z.number().positive().optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    note: z.string().optional(),
  })
  .catchall(z.unknown());

function formatConfirmation(result: LogWeightSuccess): string {
  let text = `Logged: ${result.weight_kg} kg`;
  if (result.note) text += ` (${result.note})`;
  text += ` on ${result.date}.`;
  return text;
}

export type WeightFastPathResult =
  | { handled: false }
  | { handled: true; confirmationText: string };

export async function tryWeightFastPath(
  userText: string,
  athleteId: string,
): Promise<WeightFastPathResult> {
  let decision;
  try {
    decision = await chat({
      model: 'claude-haiku-4-5',
      system: 'You classify and extract body weight logs for a cycling coach app.',
      messages: [{ role: 'user', content: userText }],
      tools: [CLASSIFY_AND_EXTRACT_TOOL],
      toolChoice: { name: 'classify_weight_log' },
      maxTokens: 256,
    });
  } catch (err) {
    log.warn('weight classifier failed, falling back to orchestrator', describeError(err));
    return { handled: false };
  }

  const toolUse = decision.content.find((b): b is ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) return { handled: false };

  const parsed = ClassifyResult.safeParse(toolUse.input);
  if (!parsed.success) {
    log.warn('weight classifier returned an unusable shape, falling back to orchestrator', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
    return { handled: false };
  }

  const args = parsed.data;
  if (!args.is_weight_log || args.weight_kg == null) return { handled: false };

  let outcome;
  try {
    outcome = await logWeight(
      {
        weight_kg: args.weight_kg,
        date: args.date,
        note: args.note,
      },
      athleteId,
    );
  } catch (err) {
    log.error('logWeight failed, falling back to orchestrator', describeError(err));
    return { handled: false };
  }

  if (!outcome.ok) {
    log.warn('logWeight declined, falling back to orchestrator', { error: outcome.error });
    return { handled: false };
  }

  return { handled: true, confirmationText: formatConfirmation(outcome) };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/bff && npx tsc --noEmit
```

Expected: no errors.

---

## Task 7: Fast-path tests — `fast-path-weight.test.ts`

**Files:**
- Create: `apps/bff/src/modules/chat/fast-path-weight.test.ts`
- Test: `apps/bff/src/modules/chat/fast-path-weight.test.ts`

The test mocks `chat` and `logWeight` — no real LLM calls in tests. Mirrors `fast-path-meal-log.test.ts` structure.

- [ ] **Step 1: Write the tests**

Create `apps/bff/src/modules/chat/fast-path-weight.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock before importing the module under test so the bindings are replaced
vi.mock('../claude/claude.client.js', () => ({
  chat: vi.fn(),
}));
vi.mock('../tools/log-weight.js', () => ({
  logWeight: vi.fn(),
}));

import { chat } from '../claude/claude.client.js';
import { logWeight } from '../tools/log-weight.js';
import { tryWeightFastPath } from './fast-path-weight.js';

const mockChat = vi.mocked(chat);
const mockLogWeight = vi.mocked(logWeight);

function makeClassifierResponse(input: Record<string, unknown>) {
  return {
    content: [{ type: 'tool_use' as const, id: 'x', name: 'classify_weight_log', input }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tryWeightFastPath', () => {
  it('returns handled:true and confirmation for a plain weight message', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: true, weight_kg: 74.5 }) as never,
    );
    mockLogWeight.mockResolvedValueOnce({
      ok: true,
      id: 'abc',
      date: '2026-08-03',
      weight_kg: 74.5,
    });

    const result = await tryWeightFastPath('I weigh 74.5 kg', 'athlete-1');

    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.confirmationText).toContain('74.5 kg');
    expect(result.confirmationText).toContain('2026-08-03');
  });

  it('returns handled:false when is_weight_log is false', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: false }) as never,
    );

    const result = await tryWeightFastPath('What should I eat before a race?', 'athlete-1');
    expect(result.handled).toBe(false);
    expect(mockLogWeight).not.toHaveBeenCalled();
  });

  it('returns handled:false when weight_kg is missing from classifier output', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: true }) as never,
    );

    const result = await tryWeightFastPath('I weighed in', 'athlete-1');
    expect(result.handled).toBe(false);
  });

  it('returns handled:false when the chat call throws', async () => {
    mockChat.mockRejectedValueOnce(new Error('rate limit'));

    const result = await tryWeightFastPath('I weigh 75 kg', 'athlete-1');
    expect(result.handled).toBe(false);
  });

  it('returns handled:false when no tool_use block is returned', async () => {
    mockChat.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] } as never);

    const result = await tryWeightFastPath('I weigh 75 kg', 'athlete-1');
    expect(result.handled).toBe(false);
  });

  it('returns handled:false when logWeight throws', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: true, weight_kg: 73.0 }) as never,
    );
    mockLogWeight.mockRejectedValueOnce(new Error('db error'));

    const result = await tryWeightFastPath('73 kg this morning', 'athlete-1');
    expect(result.handled).toBe(false);
  });

  it('returns handled:false when logWeight returns ok:false', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: true, weight_kg: 73.0 }) as never,
    );
    mockLogWeight.mockResolvedValueOnce({ ok: false, error: 'something wrong' });

    const result = await tryWeightFastPath('73 kg this morning', 'athlete-1');
    expect(result.handled).toBe(false);
  });

  it('includes the note in the confirmation text', async () => {
    mockChat.mockResolvedValueOnce(
      makeClassifierResponse({ is_weight_log: true, weight_kg: 72.0, note: 'morning fasted' }) as never,
    );
    mockLogWeight.mockResolvedValueOnce({
      ok: true,
      id: 'def',
      date: '2026-08-03',
      weight_kg: 72.0,
      note: 'morning fasted',
    });

    const result = await tryWeightFastPath('72 kg this morning fasted', 'athlete-1');
    expect(result.handled).toBe(true);
    if (!result.handled) return;
    expect(result.confirmationText).toContain('morning fasted');
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
npx vitest run apps/bff/src/modules/chat/fast-path-weight.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/bff/src/modules/chat/fast-path-weight.ts apps/bff/src/modules/chat/fast-path-weight.test.ts
git commit -m "feat: add weight fast-path (Haiku classify + extract, silent fallback)"
```

---

## Task 8: Wire the fast path into the controller

**Files:**
- Modify: `apps/bff/src/modules/chat/chat.controller.ts`

- [ ] **Step 1: Add the import**

At the top of `chat.controller.ts`, after the `tryMealLogFastPath` import, add:

```typescript
import { tryWeightFastPath } from './fast-path-weight.js';
```

- [ ] **Step 2: Chain the fast-path checks**

Find lines 144–155 in `chat.controller.ts`:

```typescript
    const fastPath = typeof latestUserMessage.content === 'string'
      ? await tryMealLogFastPath(latestUserMessage.content, athleteId)
      : { handled: false as const };

    const producedMessages = fastPath.handled
      ? pipeFastPathReply(res, chatId, fastPath.confirmationText)
      : await pipeStreamWithToolExecution(res, {
          athleteId,
          chatId,
          contextPreamble: await buildSlimPreamble(athleteId),
          messages: compressMessages([...history, newUserMessage]),
        });
```

Replace with:

```typescript
    const rawText =
      typeof latestUserMessage.content === 'string' ? latestUserMessage.content : null;

    const fastPath = rawText
      ? ((await tryMealLogFastPath(rawText, athleteId)).handled
          ? await tryMealLogFastPath(rawText, athleteId)
          : await tryWeightFastPath(rawText, athleteId))
      : { handled: false as const };
```

Wait — that would call `tryMealLogFastPath` twice on a meal message. Use the correct pattern:

```typescript
    const rawText =
      typeof latestUserMessage.content === 'string' ? latestUserMessage.content : null;

    let fastPath: { handled: false } | { handled: true; confirmationText: string } = {
      handled: false,
    };
    if (rawText) {
      const mealResult = await tryMealLogFastPath(rawText, athleteId);
      fastPath = mealResult.handled ? mealResult : await tryWeightFastPath(rawText, athleteId);
    }

    const producedMessages = fastPath.handled
      ? pipeFastPathReply(res, chatId, fastPath.confirmationText)
      : await pipeStreamWithToolExecution(res, {
          athleteId,
          chatId,
          contextPreamble: await buildSlimPreamble(athleteId),
          messages: compressMessages([...history, newUserMessage]),
        });
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd apps/bff && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run the full test suite**

```bash
cd /path/to/rumble-v2 && npx vitest run
```

Expected: all tests pass, including the existing `chat.controller.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/bff/src/modules/chat/chat.controller.ts
git commit -m "feat: chain weight fast-path in chat controller"
```

---

## Task 9: Update README architecture diagram

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the fast-path box description**

In `README.md`, find the flowchart node:

```
    BFF -->|"Haiku forced tool call:\nis_meal_log = true?"| FastPath["⚡ Fast path<br/><i>Haiku · classify + extract<br/>single call · 512 tokens max</i>"]
    BFF -->|"is_meal_log = false<br/>(or any failure)"| Orch["🧠 Orchestrator<br/><i>Claude Opus</i>"]
```

Replace with:

```
    BFF -->|"Haiku forced tool call:\nmeal log or weight log?"| FastPath["⚡ Fast path<br/><i>Haiku · classify + extract<br/>single call · ≤512 tokens</i>"]
    BFF -->|"not fast-path<br/>(or any failure)"| Orch["🧠 Orchestrator<br/><i>Claude Opus</i>"]
```

- [ ] **Step 2: Update the explanatory paragraph**

Find in `README.md`:

```
Meal logging is currently the only fast path.
```

Replace with:

```
Two fast paths exist today: **meal logging** ("had oats and banana") and **weight logging** ("I weigh 74 kg"). Both follow the same pattern. Any failure at any step of either fast path falls through silently to the full orchestrator.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README to reflect weight fast-path"
```

---

## Self-review

**Spec coverage:**
- ✅ `weight_logs` table with daily upsert — Task 1 + 2
- ✅ `log_weight` tool handler (orchestrator path) — Task 3 + 4 + 5
- ✅ Fast path (Haiku classify + extract, silent fallback) — Task 6 + 7
- ✅ Controller wiring — Task 8
- ✅ README updated — Task 9

**Placeholder scan:** None found — all steps contain complete code.

**Type consistency check:**
- `LogWeightSuccess` defined in `log-weight.ts`, imported in `fast-path-weight.ts` — ✅
- `WeightFastPathResult` discriminated union matches `MealLogFastPathResult` shape — ✅
- Controller `fastPath` variable typed as the union of both fast-path results — ✅
- `logWeight` handler signature matches `ToolHandler` type (`(args, athleteId) => Promise<ToolOutcome>`) — ✅ (`LogWeightSuccess | ToolFailure` satisfies `ToolOutcome`)

**Edge cases covered:**
- Same-day upsert tested in Task 4
- Missing `weight_kg` in classifier output → `handled: false` tested in Task 7
- `logWeight` returning `ok: false` → `handled: false` tested in Task 7
- Cross-tenant isolation tested in Task 4
