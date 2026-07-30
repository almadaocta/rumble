/**
 * Importing this module must not touch the filesystem.
 *
 * It holds the model constants and the specialist name list, so the tool
 * registry imports it — and through the registry, most of the app and its tests.
 * Assembling all four specialists eagerly meant ~44 KB off disk across four
 * knowledge-base directories plus five prompt files for anything that wanted
 * ORCHESTRATOR_MODEL.
 *
 * Asserted by counting reads through a spy installed before the import, which is
 * the only way this claim can fail loudly: an earlier version of this file
 * patched the fs namespace and reported zero reads because model-config binds
 * readFileSync at import and never looks at the namespace again. Spying on the
 * module's own binding via vi.mock is what makes the count real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readFileSyncSpy, readdirSyncSpy } = vi.hoisted(() => ({
  readFileSyncSpy: vi.fn(),
  readdirSyncSpy: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      readFileSyncSpy(args[0]);
      return actual.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      readdirSyncSpy(args[0]);
      return actual.readdirSync(...args);
    },
  };
});

// A static import would be hoisted above the spy setup; this is deliberate.
const modelConfig = await import('./model-config.js');

// Snapshotted immediately, before any test can clear the spies. These are the
// actual import-time read counts.
const READS_AT_IMPORT = {
  files: readFileSyncSpy.mock.calls.length,
  dirs: readdirSyncSpy.mock.calls.length,
};

beforeEach(() => {
  readFileSyncSpy.mockClear();
  readdirSyncSpy.mockClear();
});

describe('model-config import cost', () => {
  it('read nothing off disk at import', () => {
    expect(READS_AT_IMPORT).toEqual({ files: 0, dirs: 0 });
  });

  it('still exposes the model constant', () => {
    expect(modelConfig.ORCHESTRATOR_MODEL).toBe('claude-opus-4-8');
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  it('exposes the specialist names without reading anything', () => {
    expect(modelConfig.SPECIALIST_NAMES).toEqual([
      'cycling_coach',
      'nutritionist',
      'strength_conditioning',
      'recovery',
    ]);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
    expect(readdirSyncSpy).not.toHaveBeenCalled();
  });

  it('validates a specialist name without reading anything', () => {
    expect(modelConfig.isSpecialist('recovery')).toBe(true);
    expect(modelConfig.isSpecialist('astrologer')).toBe(false);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });
});

describe('getSpecialist', () => {
  it('reads the prompt and knowledge base on first call', () => {
    const config = modelConfig.getSpecialist('cycling_coach');

    expect(config.model).toBe('claude-haiku-4-5');
    expect(config.systemPrompt.length).toBeGreaterThan(0);
    expect(config.knowledgeBase).toContain('<document filename=');
    expect(readdirSyncSpy).toHaveBeenCalled();
  });

  it('reads nothing on the second call, and returns the identical object', () => {
    const first = modelConfig.getSpecialist('nutritionist');
    readFileSyncSpy.mockClear();
    readdirSyncSpy.mockClear();

    const second = modelConfig.getSpecialist('nutritionist');

    // Byte-identical matters: the knowledge base ships in the cached system
    // prefix, and a re-read that reordered anything would silently stop the
    // prompt cache from hitting.
    expect(second).toBe(first);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
    expect(readdirSyncSpy).not.toHaveBeenCalled();
  });

  it('concatenates the library in sorted filename order', () => {
    const { knowledgeBase } = modelConfig.getSpecialist('recovery');
    const names = [...knowledgeBase.matchAll(/<document filename="([^"]+)">/g)].map((m) => m[1]);

    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual([...names].sort());
  });

  it('memoises the orchestrator prompt too', () => {
    const first = modelConfig.orchestratorSystemPrompt();
    readFileSyncSpy.mockClear();

    expect(modelConfig.orchestratorSystemPrompt()).toBe(first);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });
});
