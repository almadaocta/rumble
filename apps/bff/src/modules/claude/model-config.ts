import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { TRAINING_PHASES, EXPERIENCE_LEVELS } from '../tools/vocabularies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, 'prompts');

/**
 * Locates the workspace root by walking up for its marker file.
 *
 * Anchored on a marker file rather than counted upward with `'../../../..'`,
 * which is correct only while this module stays at exactly its current depth and
 * resolves somewhere plausible-looking rather than failing when it moves. It
 * also survives the src/ vs dist/ difference without the two happening to be the
 * same depth.
 *
 * Resolved from this file rather than cwd, because the BFF runs with
 * cwd=apps/bff while scripts get run from the repo root.
 */
function findWorkspaceRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate the workspace root (no pnpm-workspace.yaml above ${__dirname}). ` +
          'The knowledge base is resolved relative to it.',
      );
    }
    dir = parent;
  }
}

/**
 * Prompt text, memoised per file.
 *
 * Read on demand, not at import: this module also holds the model constants, and
 * nothing that only wants ORCHESTRATOR_MODEL — or the list of specialist names,
 * which the tool registry needs to build its schema — should have to touch the
 * filesystem to get it.
 */
const promptCache = new Map<string, string>();

function loadPrompt(file: string): string {
  let cached = promptCache.get(file);
  if (cached === undefined) {
    cached = readFileSync(join(PROMPTS_DIR, file), 'utf-8').trim();
    promptCache.set(file, cached);
  }
  return cached;
}

// Orchestrator: owns the conversation, decides which tools/specialists to
// call. Change this one constant to retune cost/quality for the whole app.
export const ORCHESTRATOR_MODEL = 'claude-opus-4-8';

/** Memoised, so the cached prompt prefix stays byte-identical across calls. */
export function orchestratorSystemPrompt(): string {
  return loadPrompt('orchestrator.md');
}

export type Specialist = 'cycling_coach' | 'nutritionist' | 'strength_conditioning' | 'recovery';

export interface SpecialistConfig {
  model: string;
  systemPrompt: string;
  /** The specialist's entire document library, concatenated. See loadKnowledgeBase. */
  knowledgeBase: string;
}

/**
 * Which model and which files back each specialist. Pure data — importing this
 * module reads nothing off disk.
 *
 * Swap any one model to claude-sonnet-5 independently if Haiku's answers feel
 * thin for a given vertical; nothing else needs to change.
 */
const SPECIALIST_SOURCES: Record<Specialist, { model: string; prompt: string; kbFolder: string }> = {
  cycling_coach: {
    model: 'claude-haiku-4-5',
    prompt: 'cycling-coach.md',
    kbFolder: 'cycling-coach',
  },
  nutritionist: {
    model: 'claude-haiku-4-5',
    prompt: 'nutritionist.md',
    kbFolder: 'nutritionist',
  },
  strength_conditioning: {
    model: 'claude-haiku-4-5',
    prompt: 'sc-coach.md',
    kbFolder: 'sc-coach',
  },
  recovery: {
    model: 'claude-haiku-4-5',
    prompt: 'recovery.md',
    kbFolder: 'recovery',
  },
};

/** The specialist names, for the tool schema and for validating tool input. */
export const SPECIALIST_NAMES = Object.keys(SPECIALIST_SOURCES) as Specialist[];

export function isSpecialist(value: string): value is Specialist {
  return value in SPECIALIST_SOURCES;
}

/**
 * What each specialist needs to answer well, declared by the specialist
 * rather than assembled ad hoc by the orchestrator on every consult.
 *
 * consult-specialist.ts validates athlete_context against this before the
 * specialist is ever called — a missing required field (e.g. weight_kg for
 * the nutritionist) fails the tool call with a named-field error the
 * orchestrator can act on, instead of the specialist quietly reasoning
 * without it. Pure data, like SPECIALIST_SOURCES above: no disk I/O.
 */
export const SPECIALIST_CONTEXT_CONTRACTS: Record<Specialist, z.ZodObject<z.ZodRawShape>> = {
  nutritionist: z.object({
    weight_kg: z.number(),
    current_phase: z.enum(TRAINING_PHASES).optional(),
    daily_calorie_adjustment: z.number().optional(),
    upcoming_load_tss: z.number().optional(),
  }),
  cycling_coach: z.object({
    ftp_w: z.number(),
    tsb: z.number().optional(),
    current_phase: z.enum(TRAINING_PHASES).optional(),
    weekly_hours_target: z.number().optional(),
  }),
  strength_conditioning: z.object({
    experience_level: z.enum(EXPERIENCE_LEVELS).optional(),
    current_phase: z.enum(TRAINING_PHASES).optional(),
    available_hours_week: z.number().optional(),
  }),
  recovery: z.object({
    tsb: z.number(),
    ctl: z.number().optional(),
    atl: z.number().optional(),
  }),
};

export function getContextContract(vertical: Specialist): z.ZodObject<z.ZodRawShape> {
  return SPECIALIST_CONTEXT_CONTRACTS[vertical];
}

/**
 * Fixed priority when two specialists directly contradict each other on the
 * same question. Lower number wins. Deliberately not something a model
 * decides: arbitrate-specialists.ts asks a model to *detect* a contradiction
 * and *phrase* why it matters — both genuinely need judgment — but which
 * domain wins is a two-line lookup, and leaving that to a model turns a
 * guarantee into a probability.
 *
 * safety (recovery) > goal-adherence (the athlete's own coach) >
 * optimization (nutrition, strength — both tier 3, neither outranks the
 * other; a contradiction between just these two isn't a priority question).
 */
export const SPECIALIST_PRIORITY_TIER: Record<Specialist, number> = {
  recovery: 1,
  cycling_coach: 2,
  nutritionist: 3,
  strength_conditioning: 3,
};

/**
 * The higher-priority (lower tier) of two conflicting specialists, or `null`
 * on a genuine tie (nutritionist vs strength_conditioning today).
 *
 * A tie was originally resolved to `a` — arbitrary, since `a`/`b` are just
 * whichever order the arbitration classifier happened to name the domains
 * in. A recorded eval fixture (creatine timing, nutritionist vs
 * strength_conditioning) caught the real consequence: the classifier's own
 * `reason` text argued for strength_conditioning while the forced pick was
 * nutritionist, so the athlete would have read a "we went with X" notice
 * whose stated reason argued for the domain that lost. There is no
 * principled winner between two equal-tier domains — returning `null` here
 * is what stops arbitrate-specialists.ts from manufacturing one.
 */
export function higherPrioritySpecialist(a: Specialist, b: Specialist): Specialist | null {
  const tierA = SPECIALIST_PRIORITY_TIER[a];
  const tierB = SPECIALIST_PRIORITY_TIER[b];
  if (tierA === tierB) return null;
  return tierA < tierB ? a : b;
}

/**
 * Per-specialist required/optional field lists, folded into
 * consult_specialist's cached tool description — the orchestrator sees the
 * shape it needs to build before it ever gets a validation error back.
 * Deterministic and disk-free, so it stays byte-identical across calls (the
 * cached tool block needs that) without needing its own memoisation.
 */
export function describeSpecialistContracts(): string {
  return SPECIALIST_NAMES.map((name) => {
    const shape = SPECIALIST_CONTEXT_CONTRACTS[name].shape;
    const fields = Object.entries(shape).map(([key, field]) => (field.isOptional() ? `${key}?` : key));
    return `${name} {${fields.join(', ')}}`;
  }).join('; ');
}

/**
 * Reads a vertical's whole markdown library into one string.
 *
 * Each vertical is ~9-14k tokens — about 7% of Haiku's context window — so
 * there's nothing to gain from retrieving a subset. It ships in the cached
 * system prefix, which makes repeat consults to the same specialist a cache
 * read rather than a re-send. Sorting matters: the prefix has to be
 * byte-identical across calls or it won't cache, and readdir order isn't
 * guaranteed.
 */
function loadKnowledgeBase(vertical: Specialist): string {
  const dir = join(
    findWorkspaceRoot(),
    'rumble-knowledge-base',
    SPECIALIST_SOURCES[vertical].kbFolder,
  );
  if (!existsSync(dir)) {
    throw new Error(`Knowledge-base directory missing for "${vertical}": ${dir}`);
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  if (files.length === 0) {
    throw new Error(`No knowledge-base documents found for "${vertical}" in ${dir}`);
  }

  return files
    .map((f) => {
      const body = readFileSync(join(dir, f), 'utf-8').trim();
      return `<document filename="${f}">\n${body}\n</document>`;
    })
    .join('\n\n');
}

/**
 * A specialist's full config, assembled and memoised on first consult.
 *
 * Assembling all four at import means ~44 KB off disk across four knowledge-base
 * directories plus five prompt files, paid by anything that imports this module
 * for any reason — which includes the tool registry, and so most of the app and
 * its tests. It also couples module initialisation to the knowledge base being
 * present on disk, which is a runtime concern, not a load-time one.
 *
 * Memoising keeps the prompt-cache prefix byte-identical across calls, which is
 * the property that actually matters.
 */
const specialistCache = new Map<Specialist, SpecialistConfig>();

export function getSpecialist(vertical: Specialist): SpecialistConfig {
  let cached = specialistCache.get(vertical);
  if (cached === undefined) {
    const source = SPECIALIST_SOURCES[vertical];
    cached = {
      model: source.model,
      systemPrompt: loadPrompt(source.prompt),
      knowledgeBase: loadKnowledgeBase(vertical),
    };
    specialistCache.set(vertical, cached);
  }
  return cached;
}
