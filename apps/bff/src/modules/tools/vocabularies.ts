/**
 * The closed sets that appear in a tool's published JSON Schema.
 *
 * Each appears in two places: a JSON Schema `enum` telling the model what it
 * may send, and a `z.enum` in the handler deciding what it will accept. Drift
 * between them is quiet in both directions — a value in the schema alone is one
 * the model offers and the handler rejects as invalid arguments; a value in the
 * handler alone is one the model is never told exists.
 *
 * So: one `as const` tuple per vocabulary, spread into the schema
 * (`enum: [...X]`) and passed to zod (`z.enum(X)`). No abstraction, just one
 * list instead of two.
 *
 * Not everything closed lives here. ACTIVITY_TYPES stays in
 * activities/normalized-activity.ts because it types a persisted domain field
 * that the source adapters produce — a tool happens to filter on it. The rule
 * is: if the set exists because a tool publishes it, it belongs here; if it
 * exists because the domain has it, it belongs with the domain.
 */

// --- log_meal ---

export const MEAL_TYPES = [
  'breakfast',
  'lunch',
  'dinner',
  'snack',
  'pre_ride',
  'during_ride',
  'post_ride',
] as const;

export const CONFIDENCE_TIERS = [1, 2, 3] as const;

export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

// --- update_training_plan ---

export const PLAN_ACTIONS = ['create', 'update', 'add_sessions', 'remove_sessions'] as const;

export const TRAINING_PHASES = ['base', 'build', 'peak', 'race', 'recovery', 'off_season'] as const;

export const SESSION_TYPES = ['ride', 'gym', 'recovery', 'rest'] as const;

// --- update_ftp_and_zones ---

export const FTP_SOURCES = [
  'ramp_test',
  'twenty_min_test',
  'eight_min_test',
  'race_result',
  'ride_estimate',
  'coach_estimate',
] as const;

// --- update_athlete_profile ---

export const SEXES = ['male', 'female'] as const;

export const EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'advanced', 'elite'] as const;

export const PRIMARY_GOALS = [
  'general_fitness',
  'weight_loss',
  'endurance',
  'speed',
  'ftp_improvement',
  'gran_fondo',
  'road_race',
  'gravel_race',
  'time_trial',
  'criterium',
] as const;

// --- save_target_event ---

export const EVENT_ACTIONS = ['add', 'remove'] as const;

export const EVENT_TYPES = [
  'road_race',
  'gravel_race',
  'gran_fondo',
  'time_trial',
  'criterium',
  'sportive',
  'other',
] as const;

export const EVENT_PRIORITIES = ['A', 'B', 'C'] as const;

// --- save_coaching_note ---

export const NOTE_CATEGORIES = [
  'preference',
  'constraint',
  'health',
  'schedule',
  'observation',
  'decision',
  'nutrition',
  'general',
] as const;

/**
 * Categories safety/identity-critical enough to send in full on every turn —
 * injury status and standing constraints shape what's safe to recommend
 * regardless of what the conversation is about. Everything else is only
 * summarized in the preamble (an index) and fetched in full via
 * get_coaching_notes when it's actually relevant, to keep per-turn cost from
 * growing unbounded as notes accumulate over a season.
 */
export const PINNED_NOTE_CATEGORIES = ['health', 'constraint', 'preference'] as const;
