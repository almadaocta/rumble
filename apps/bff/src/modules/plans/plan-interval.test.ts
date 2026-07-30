/**
 * The interval shape exists twice: as a zod schema (what the tool accepts) and
 * as JSON Schema (what the model is told it may send). The second is
 * hand-mirrored, because generating it would mean a zod-to-JSON-Schema
 * dependency for one object.
 *
 * Drift between them is the quiet kind — a field in zod but not the schema is
 * one the model never learns exists, and a field in the schema but not zod is
 * one the model offers and the tool rejects as invalid arguments. These tests
 * are what makes the mirror hold.
 */
import { describe, it, expect } from 'vitest';
import {
  PlanInterval,
  PlanIntervals,
  PLAN_INTERVAL_TYPES,
  PLAN_INTERVAL_LEGACY_FIELDS,
  PLAN_INTERVAL_JSON_SCHEMA,
} from './plan-interval.js';

/** Every field name across all four members of the union. */
function zodFields(): string[] {
  const names = new Set<string>();
  for (const option of PlanInterval.options) {
    for (const key of Object.keys(option.shape)) names.add(key);
  }
  return [...names].sort();
}

describe('PLAN_INTERVAL_JSON_SCHEMA mirrors the zod schema', () => {
  it('accounts for every field zod accepts, as published or explicitly legacy', () => {
    const published = Object.keys(PLAN_INTERVAL_JSON_SCHEMA.properties);
    expect([...published, ...PLAN_INTERVAL_LEGACY_FIELDS].sort()).toEqual(zodFields());
  });

  it('does not publish the legacy field names', () => {
    // The parser reads them so old stored sessions still push; the model is not
    // told about them so new sessions aren't written with them.
    for (const legacy of PLAN_INTERVAL_LEGACY_FIELDS) {
      expect(PLAN_INTERVAL_JSON_SCHEMA.properties).not.toHaveProperty(legacy);
    }
  });

  it('publishes the same four interval types', () => {
    expect(PLAN_INTERVAL_JSON_SCHEMA.properties.type.enum).toEqual([...PLAN_INTERVAL_TYPES]);
    expect(PlanInterval.options.map((o) => o.shape.type.value).sort()).toEqual(
      [...PLAN_INTERVAL_TYPES].sort(),
    );
  });

  it('marks as required exactly the fields zod has no default or optional for', () => {
    // type and duration_s are the two every member needs.
    expect([...PLAN_INTERVAL_JSON_SCHEMA.required].sort()).toEqual(['duration_s', 'type']);
    for (const option of PlanInterval.options) {
      expect(option.shape.duration_s.isOptional()).toBe(false);
    }
  });
});

describe('PlanIntervals parsing', () => {
  it('accepts a realistic session', () => {
    const parsed = PlanIntervals.safeParse([
      { type: 'warmup', duration_s: 600, start_pct: 0.5, end_pct: 0.75 },
      {
        type: 'interval',
        name: 'threshold',
        duration_s: 300,
        power_pct: 0.98,
        rest_s: 180,
        rest_pct: 0.5,
        repeats: 4,
      },
      { type: 'cooldown', duration_s: 600 },
    ]);

    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown interval type rather than storing it', () => {
    const parsed = PlanIntervals.safeParse([{ type: 'sprint', duration_s: 30 }]);
    expect(parsed.success).toBe(false);
  });

  it('rejects an interval with no duration', () => {
    // The old z.array(z.unknown()) stored this happily; buildWahooPlanFile then
    // substituted its own default and the athlete rode a step nobody chose.
    const parsed = PlanIntervals.safeParse([{ type: 'steady', power_pct: 0.85 }]);
    expect(parsed.success).toBe(false);
  });

  it('rejects a zero or negative duration', () => {
    expect(PlanIntervals.safeParse([{ type: 'steady', duration_s: 0 }]).success).toBe(false);
    expect(PlanIntervals.safeParse([{ type: 'steady', duration_s: -60 }]).success).toBe(false);
  });
});
