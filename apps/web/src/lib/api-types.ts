/**
 * The BFF response shapes this app consumes.
 *
 * Declared once here, matching the Drizzle column types, rather than in each
 * component that fetches them. Hand-declared per component they diverge quietly:
 * `Activity.distanceM` and `Activity.tss` were `string | null` in the list
 * payload and `number | null` in the detail payload — the same `real()` columns,
 * which Drizzle returns as numbers — and nothing caught it because `parseFloat`
 * accepts a number at runtime. The only visible symptom was two near-identical
 * distance formatters.
 *
 * There is no build-time link between the two packages, so this file is the
 * seam: if a BFF payload changes, this is what has to change with it.
 */
import type { Specialist } from './specialists';

/** `activities` rows as returned by GET /api/activities. */
export interface Activity {
  id: string;
  type: string;
  name: string | null;
  startedAt: string;
  durationS: number;
  /** real() column — metres. */
  distanceM: number | null;
  avgPower: number | null;
  normPower: number | null;
  /** real() column. */
  tss: number | null;
  calories: number | null;
}

/** One lap of an activity, from GET /api/activities/:id. */
export interface ActivityLap {
  id: string;
  lapIndex: number;
  durationS: number;
  distanceM: number | null;
  avgPower: number | null;
  maxPower: number | null;
  normPower: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
}

/** The full activity detail payload, GET /api/activities/:id. */
export interface ActivityFull {
  id: string;
  type: string;
  name: string | null;
  startedAt: string;
  durationS: number;
  distanceM: number | null;
  avgPower: number | null;
  normPower: number | null;
  maxPower: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  elevationM: number | null;
  calories: number | null;
  tss: number | null;
  intensityFactor: number | null;
  laps: ActivityLap[];
}

/** `plan_sessions` rows as returned by GET /api/athlete/sessions. */
export interface PlanSession {
  id: string;
  scheduledDate: string;
  sessionType: string;
  title: string;
  description: string | null;
  targetTss: number | null;
  targetDurationMin: number | null;
  targetIf: number | null;
  completed: boolean;
  feedbackRpe: number | null;
}

export interface AthleteProfile {
  name: string;
  ftp: number | null;
  weightKg: number | null;
  /** Pre-formatted by the BFF to 2dp, hence a string. */
  wkg: string | null;
  age: number | null;
  heightCm: number | null;
  sex: string | null;
  availableHoursWeek: number | null;
  experienceLevel: string | null;
  timezone: string | null;
}

export interface Fitness {
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  rampRate: number | null;
}

export interface NextEvent {
  name: string;
  eventDate: string;
  eventType: string | null;
  priority: string | null;
}

/** GET /api/athlete/stats. */
export interface AthleteStats {
  profile: AthleteProfile;
  maxHr: number | null;
  powerBests: Record<string, number | null>;
  fitness: Fitness | null;
  nextEvent: NextEvent | null;
  thisWeek: { tss: number; hours: number; rides: number };
}

/**
 * Frames on the chat SSE stream (POST /api/chat).
 *
 * Mirrors apps/bff/src/modules/chat/sse-frame.ts, and sse-frame.test.ts fails if
 * the two drift. Described as "whatever" on either end — `data: unknown` on the
 * server, an all-optional `{ type?: string; delta?: string }` here — neither side
 * checks what the other sent, and a frame with a misspelled type or a missing
 * delta is silently dropped, leaving a piece missing from the athlete's reply.
 */
export type SseFrame =
  | { type: 'start'; id: string }
  | { type: 'start-step' }
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'specialist-message'; specialist: Specialist; text: string }
  | { type: 'contradiction-notice'; domains: [Specialist, Specialist]; chosenDomain: Specialist; oneLineReason: string }
  | { type: 'finish-step' }
  | { type: 'finish'; usage?: unknown }
  | { type: 'error'; errorText: string };

/** One row of GET /api/nutrition/today's `meals`. */
export interface Meal {
  id: string;
  mealType: string | null;
  description: string;
  calories: number | null;
  carbsG: number | null;
  proteinG: number | null;
  fatG: number | null;
  /** confidence_tier 3 — estimated from a description rather than weighed. */
  estimated: boolean;
}

/** GET /api/nutrition/today. All totals are null when nothing is logged. */
export interface NutritionToday {
  logged: boolean;
  calories: number | null;
  carbsG: number | null;
  proteinG: number | null;
  fatG: number | null;
  /** Total calories burned from today's activities. Always 0 or more. */
  burned: number;
  /** Computed daily calorie target (BMR + adjustment). Null if profile incomplete. */
  target: number | null;
  /** The stored daily_calorie_adjustment. 0 = maintenance, negative = deficit, positive = surplus. */
  calorieAdjustment: number;
  meals: Meal[];
}

/** POST /api/wahoo/sync. `queued: false` means one was already in flight. */
export interface WahooSyncStarted {
  queued: boolean;
  message: string;
}

/** GET /api/wahoo/status. */
export interface WahooStatus {
  connected: boolean;
  syncStatus: 'idle' | 'syncing' | 'complete' | 'failed';
  /** Present only when the last background sync threw. */
  lastSyncError?: string;
  activityCount: number;
  lastSyncAt: string | null;
}

/**
 * GET /api/health.
 *
 * `wahoo` reports whether the integration is configured at all — distinct from
 * whether this athlete has connected it. Without that distinction the client
 * cannot tell "not linked yet" from "the routes were never mounted", and offers
 * a Connect button that navigates to a route that does not exist.
 */
export interface HealthStatus {
  status: string;
  wahoo: boolean;
  timestamp: string;
}
