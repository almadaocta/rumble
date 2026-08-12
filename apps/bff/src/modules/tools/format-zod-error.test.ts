import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formatZodIssues } from './format-zod-error.js';

describe('formatZodIssues', () => {
  it('names each offending field, not a JSON dump of the issue array', () => {
    const schema = z.object({ weight_kg: z.number(), tsb: z.number() });
    const result = schema.safeParse({});
    if (result.success) throw new Error('expected parse to fail');

    const message = formatZodIssues(result.error.issues);

    expect(message).toContain('weight_kg');
    expect(message).toContain('tsb');
    expect(message).not.toContain('"code"');
  });

  it('labels a root-level issue explicitly rather than leaving the path blank', () => {
    const schema = z.number();
    const result = schema.safeParse('not a number');
    if (result.success) throw new Error('expected parse to fail');

    expect(formatZodIssues(result.error.issues)).toContain('(root)');
  });
});
