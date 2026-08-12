import type { z } from 'zod';

/**
 * Turns zod issues into a compact, field-named message a model can act on.
 *
 * The bare ZodError message is a JSON dump of the issue array — useless to a
 * model deciding what to fix. Shared by tool.executor.ts (thrown ZodErrors
 * from a handler's `.parse()`) and consult-specialist.ts (safeParse'd context
 * contracts), so a missing/invalid field reads identically regardless of
 * which one caught it.
 */
export function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
