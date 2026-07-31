/**
 * The orchestrator's advertised tool surface.
 *
 * `wahooEnabled` used to gate only the HTTP router, so in chat-only mode the
 * model was still handed push_workout_to_device and would promise the athlete a
 * workout push that failed several layers later at the token lookup. These
 * tests pin what the model is told about, in both configurations.
 *
 * The module reads `wahooEnabled` at import, so each case re-imports it under a
 * fresh module registry with the relevant env in place.
 *
 * That re-import walks the whole tool graph — 15 handlers and their schemas —
 * and under a loaded parallel run it has been observed at 5.4s against vitest's
 * 5s default. These are CPU-bound, not waiting on anything, so the timeout is
 * raised rather than the work reduced: a re-import that is merely slow should
 * not read as a failure.
 */
const REIMPORT_TIMEOUT_MS = 30_000;
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getDb } from '../../db/client.js';

afterAll(() => {
  // Close the SQLite handle opened by the last dynamic re-import so the
  // forks-pool subprocess doesn't hang waiting for the connection to drain.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (getDb() as any)._.client.close();
  } catch {
    // already closed or never opened — safe to ignore
  }
});

const WAHOO_ENV = {
  WAHOO_CLIENT_ID: 'test-client-id',
  WAHOO_CLIENT_SECRET: 'test-client-secret',
};

async function loadToolsWith(env: Record<string, string>) {
  vi.resetModules();
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    if (v === '') delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import('./tool.executor.js');
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('ORCHESTRATOR_TOOLS with Wahoo configured', () => {
  beforeEach(() => vi.resetModules());

  it('advertises the device push', async () => {
    const { ORCHESTRATOR_TOOLS } = await loadToolsWith(WAHOO_ENV);
    expect(ORCHESTRATOR_TOOLS.map((t) => t.name)).toContain('push_workout_to_device');
  }, REIMPORT_TIMEOUT_MS);

  it('keeps the push_to_device option on update_ftp_and_zones', async () => {
    const { ORCHESTRATOR_TOOLS } = await loadToolsWith(WAHOO_ENV);
    const tool = ORCHESTRATOR_TOOLS.find((t) => t.name === 'update_ftp_and_zones');
    const props = (tool?.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('push_to_device');
  }, REIMPORT_TIMEOUT_MS);
});

describe('ORCHESTRATOR_TOOLS in chat-only mode', () => {
  beforeEach(() => vi.resetModules());

  it('does not advertise a device push the app cannot perform', async () => {
    const { ORCHESTRATOR_TOOLS } = await loadToolsWith({
      WAHOO_CLIENT_ID: '',
      WAHOO_CLIENT_SECRET: '',
    });
    expect(ORCHESTRATOR_TOOLS.map((t) => t.name)).not.toContain('push_workout_to_device');
  }, REIMPORT_TIMEOUT_MS);

  it('strips push_to_device but keeps the local zone update', async () => {
    const { ORCHESTRATOR_TOOLS } = await loadToolsWith({
      WAHOO_CLIENT_ID: '',
      WAHOO_CLIENT_SECRET: '',
    });
    const names = ORCHESTRATOR_TOOLS.map((t) => t.name);
    expect(names).toContain('update_ftp_and_zones');

    const tool = ORCHESTRATOR_TOOLS.find((t) => t.name === 'update_ftp_and_zones');
    const props = (tool?.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty('push_to_device');
    // The rest of the tool is untouched — only the Wahoo-dependent option goes.
    expect(Object.keys(props).length).toBeGreaterThan(0);
  }, REIMPORT_TIMEOUT_MS);

  it('leaves every non-Wahoo tool advertised', async () => {
    const enabled = await loadToolsWith(WAHOO_ENV);
    const disabled = await loadToolsWith({ WAHOO_CLIENT_ID: '', WAHOO_CLIENT_SECRET: '' });

    const removed = enabled.ORCHESTRATOR_TOOLS.map((t) => t.name).filter(
      (n) => !disabled.ORCHESTRATOR_TOOLS.map((t) => t.name).includes(n),
    );
    expect(removed).toEqual(['push_workout_to_device']);
  }, REIMPORT_TIMEOUT_MS);
});

describe('schema and dispatch agree', () => {
  beforeEach(() => vi.resetModules());

  it('every advertised tool resolves to a handler, and vice versa', async () => {
    const { ORCHESTRATOR_TOOLS, executeToolCall } = await loadToolsWith(WAHOO_ENV);

    // Advertised -> dispatchable. A schema entry with no handler means the model
    // is told about a tool that answers "Unknown tool" when it calls it.
    for (const tool of ORCHESTRATOR_TOOLS) {
      const result = await executeToolCall(
        { id: 'probe', name: tool.name, arguments: {} },
        'athlete-1',
      );
      expect(result.error ?? '', tool.name).not.toMatch(/unknown tool/i);
    }
  }, REIMPORT_TIMEOUT_MS);

  it('rejects a name that is in neither', async () => {
    const { executeToolCall } = await loadToolsWith(WAHOO_ENV);
    const result = await executeToolCall(
      { id: 'x', name: 'definitely_not_a_tool', arguments: {} },
      'athlete-1',
    );
    expect(result.error).toMatch(/unknown tool/i);
  }, REIMPORT_TIMEOUT_MS);

  it('surfaces a handler rejection as a readable tool result rather than throwing', async () => {
    const { executeToolCall } = await loadToolsWith(WAHOO_ENV);

    // analyze_activity hits the DB, which isn't migrated in this file — so it
    // rejects. The point is that it comes back as a result, not an exception
    // that would kill the stream mid-turn.
    const result = await executeToolCall(
      { id: 'x', name: 'analyze_activity', arguments: { activity_id: 'nope' } },
      'athlete-1',
    );

    expect(result.tool_call_id).toBe('x');
    expect(typeof result.error === 'string' || result.result !== null).toBe(true);
  }, REIMPORT_TIMEOUT_MS);
});

describe('executeToolCall argument validation', () => {
  beforeEach(() => vi.resetModules());

  it('names the offending field instead of dumping the raw ZodError', async () => {
    const { executeToolCall } = await loadToolsWith(WAHOO_ENV);

    // log_session_feedback requires session_id: string and rpe: number.
    const result = await executeToolCall(
      { id: 't1', name: 'log_session_feedback', arguments: { rpe: 'very hard' } },
      'athlete-1',
    );

    expect(result.error).toContain('Invalid arguments');
    expect(result.error).toContain('session_id');
    // The bare ZodError message is a JSON dump of the issue array — the model
    // can't act on that, so it must not be what we hand back.
    expect(result.error).not.toContain('"code"');
    expect(result.result).toBeNull();
  }, REIMPORT_TIMEOUT_MS);
});

describe('executeToolCall in chat-only mode', () => {
  beforeEach(() => vi.resetModules());

  it('reports the Wahoo tool as unknown rather than failing deep in the stack', async () => {
    const { executeToolCall } = await loadToolsWith({
      WAHOO_CLIENT_ID: '',
      WAHOO_CLIENT_SECRET: '',
    });

    const result = await executeToolCall(
      { id: 't1', name: 'push_workout_to_device', arguments: { session_id: 'abc' } },
      'athlete-1',
    );

    expect(result.error).toMatch(/unknown tool/i);
    expect(result.result).toBeNull();
  }, REIMPORT_TIMEOUT_MS);
});
