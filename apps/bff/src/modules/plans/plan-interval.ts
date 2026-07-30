import { z } from 'zod';

/**
 * The structure of a planned session, as the coach writes it and the device
 * reads it back.
 *
 * Declared once, because nothing else on this path can check it: the column is
 * JSON, the tool's published schema is what the model writes against, and the
 * Wahoo pusher reads the fields back by name. Untyped anywhere along it — a
 * `z.array(z.unknown())` argument, an "array" with no item shape, an `any[]`
 * parameter — the model invents the format on every call and a session written
 * with the wrong field names stores fine, lists fine, and becomes a silently
 * wrong workout on the athlete's head unit. The first sign of trouble is a ride
 * whose targets make no sense.
 *
 * Lives in its own module rather than in tools/ because both the tool that
 * writes intervals and the Wahoo pusher that reads them need it, and tools/
 * already depends on wahoo/ — putting it either side would close a cycle. Same
 * reasoning, and the same shape, as activities/normalized-activity.ts.
 */

/** Ramps: a linear sweep between two percentages of FTP. */
const rampFields = {
  duration_s: z.number().positive(),
  start_pct: z.number().positive().optional(),
  end_pct: z.number().positive().optional(),
  name: z.string().optional(),
};

/**
 * Efforts: a work step at a percentage of FTP, optionally followed by a
 * recovery step, optionally repeated as a set.
 */
const effortFields = {
  duration_s: z.number().positive(),
  power_pct: z.number().positive().optional(),
  /** See PLAN_INTERVAL_LEGACY_FIELDS. */
  target_pct: z.number().positive().optional(),
  rest_s: z.number().nonnegative().optional(),
  rest_pct: z.number().positive().optional(),
  repeats: z.number().int().nonnegative().optional(),
  name: z.string().optional(),
};

export const PlanInterval = z.discriminatedUnion('type', [
  z.object({ type: z.literal('warmup'), ...rampFields }),
  z.object({ type: z.literal('cooldown'), ...rampFields }),
  z.object({ type: z.literal('interval'), ...effortFields }),
  z.object({ type: z.literal('steady'), ...effortFields }),
]);

export type PlanInterval = z.infer<typeof PlanInterval>;

export const PlanIntervals = z.array(PlanInterval);

/** Shared by the zod union above and the JSON Schema below. */
export const PLAN_INTERVAL_TYPES = ['warmup', 'cooldown', 'interval', 'steady'] as const;

/**
 * Accepted by the parser but deliberately not published to the model.
 *
 * `target_pct` is what the model used before `power_pct` settled, and sessions
 * written then are still in the database — the parser has to keep reading them
 * or pushing an old plan to the device would start failing. Leaving it out of
 * the published schema is what stops new sessions from being written with it.
 * plan-interval.test.ts asserts published + legacy accounts for every field the
 * parser accepts, so this stays a decision rather than an oversight.
 */
export const PLAN_INTERVAL_LEGACY_FIELDS = ['target_pct'] as const;

/**
 * The same shape as JSON Schema, for the tool definition the model is shown.
 *
 * Hand-mirrored rather than generated: a zod-to-JSON-Schema dependency to emit
 * one object is not worth it. plan-interval.test.ts checks the property list
 * against the zod schema, which is what keeps the mirror honest.
 */
export const PLAN_INTERVAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [...PLAN_INTERVAL_TYPES],
      description:
        'warmup/cooldown ramp between start_pct and end_pct; interval/steady hold power_pct.',
    },
    duration_s: { type: 'number', description: 'Length of the work step in seconds' },
    start_pct: { type: 'number', description: 'Ramp start, as a fraction of FTP (0.5 = 50%)' },
    end_pct: { type: 'number', description: 'Ramp end, as a fraction of FTP' },
    power_pct: { type: 'number', description: 'Target power as a fraction of FTP (1.0 = FTP)' },
    rest_s: { type: 'number', description: 'Recovery after each repetition, in seconds' },
    rest_pct: { type: 'number', description: 'Recovery power as a fraction of FTP' },
    repeats: { type: 'number', description: 'How many times to repeat this work+recovery block' },
    name: { type: 'string', description: 'Short label shown on the device, e.g. "threshold"' },
  },
  required: ['type', 'duration_s'],
} as const;
