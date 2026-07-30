/**
 * The SSE frame union is mirrored: apps/bff owns it in sse-frame.ts and
 * apps/web restates it in src/lib/api-types.ts, because the two apps build
 * independently and there is no shared package.
 *
 * A mirror nobody checks is just two files that used to agree. This reads both
 * declarations and compares the frame names, so adding a frame on one side
 * without the other fails here rather than in front of an athlete — the client
 * silently ignores a frame type it doesn't know, so the symptom would be a
 * reply with a piece missing and no error anywhere.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');

const SERVER_UNION = join(HERE, 'sse-frame.ts');
const CLIENT_UNION = join(REPO, 'apps', 'web', 'src', 'lib', 'api-types.ts');

/** Every `type: 'x'` literal in the SseFrame union declaration of a file. */
function frameNames(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf('export type SseFrame =');
  expect(start, `no SseFrame union in ${path}`).toBeGreaterThan(-1);

  // The union runs to the first line ending in `;` — every member is one line.
  const body = source.slice(start).split(/;\s*$/m)[0];
  return [...body.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1]).sort();
}

describe('SSE frame contract', () => {
  it('is declared identically on both sides of the wire', () => {
    const server = frameNames(SERVER_UNION);
    expect(server.length).toBeGreaterThan(0);
    expect(frameNames(CLIENT_UNION)).toEqual(server);
  });

  it('covers every frame chat.stream.ts actually emits', () => {
    const stream = readFileSync(join(HERE, 'chat.stream.ts'), 'utf8');
    const emitted = [...stream.matchAll(/sse\(res, \{ type: '([a-z-]+)'/g)].map((m) => m[1]);

    expect(emitted.length).toBeGreaterThan(0);
    expect(new Set(emitted).size).toBeGreaterThan(1);
    for (const name of emitted) {
      expect(frameNames(SERVER_UNION)).toContain(name);
    }
  });
});
