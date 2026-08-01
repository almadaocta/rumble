import { consultSpecialist } from './consult-specialist.js';
import { getTrainingData } from './get-training-data.js';
import { getBodyMetrics } from './get-body-metrics.js';
import { getNutritionLog } from './get-nutrition-log.js';
import { logMeal } from './log-meal.js';
import { logSessionFeedback } from './log-session-feedback.js';
import { updateTrainingPlan } from './update-training-plan.js';
import { updateFtpZones } from './update-ftp-and-zones.js';
import { updateAthleteProfile } from './update-athlete-profile.js';
import { saveTargetEvent } from './save-target-event.js';
import { saveCoachingNote } from './save-coaching-note.js';
import { getCoachingNotes } from './get-coaching-notes.js';
import { pushWorkoutToDevice } from './push-workout-to-device.js';
import { getAthleteContext } from './get-athlete-context.js';
import { analyzeActivity } from './analyze-activity.js';
import type { ToolDefinition } from '../claude/claude.client.js';
import type { ToolOutcome } from './tool-result.js';
import { ACTIVITY_TYPES } from '../activities/normalized-activity.js';
import { PLAN_INTERVAL_JSON_SCHEMA } from '../plans/plan-interval.js';
import { SPECIALIST_NAMES } from '../claude/model-config.js';
import {
  MEAL_TYPES,
  CONFIDENCE_TIERS,
  PLAN_ACTIONS,
  TRAINING_PHASES,
  SESSION_TYPES,
  FTP_SOURCES,
  SEXES,
  EXPERIENCE_LEVELS,
  PRIMARY_GOALS,
  EVENT_ACTIONS,
  EVENT_TYPES,
  EVENT_PRIORITIES,
  NOTE_CATEGORIES,
} from './vocabularies.js';

/** Handlers return the shared { ok, ... } envelope — see tool-result.ts for why. */
export type ToolHandler = (
  args: Record<string, unknown>,
  athleteId: string,
) => Promise<ToolOutcome>;

/**
 * Everything the app knows about one tool, in one place.
 *
 * A tool is a handler, a JSON Schema for the list sent to Claude, and a progress
 * label for the SSE stream. Declared together because the failure modes when
 * they drift are quiet: a schema with no handler produces "Unknown tool" only
 * once the model calls it, and a handler with no label shows the athlete a raw
 * snake_case name.
 */
export interface ToolSpec {
  handler: ToolHandler;
  /** Shown in the UI while the tool runs. */
  label: string;
  /** Sent to Claude verbatim; this is the model's only documentation. */
  description: string;
  /** Claude's tool format uses `input_schema` where OpenAI's used `parameters`. */
  input_schema: ToolDefinition['input_schema'];
}

/**
 * The registry. Insertion order is the order Claude is shown the tools.
 *
 * `satisfies` rather than an annotation: it type-checks every entry while
 * keeping the literal keys, which is what makes ToolName a union of the real
 * names rather than `string`.
 */
export const TOOL_REGISTRY = {
  get_athlete_context: {
    handler: getAthleteContext,
    label: 'Loading athlete context',
    description:
      'Retrieve detailed athlete context: full profile, fitness metrics (CTL/ATL/TSB/ramp rate), recent activities, upcoming plan, coaching notes, and target events. Call this when you need background on the athlete to answer a question or make a recommendation. The slim preamble already gives you the basics — use this for deeper context.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  consult_specialist: {
    handler: consultSpecialist,
    label: 'Consulting specialist',
    description:
      'Consult a domain specialist (cycling_coach, nutritionist, strength_conditioning, recovery). Use when: creating training plans, deep domain questions the orchestrator cannot confidently answer, concerning recovery trends, specific macro calculations, or injury/pain reports.',
    input_schema: {
      type: 'object',
      properties: {
        specialist: {
          type: 'string',
          // From model-config.ts itself, so a specialist added there is offered
          // to the orchestrator without a second edit here.
          enum: [...SPECIALIST_NAMES],
          description: 'Which specialist to consult',
        },
        query: {
          type: 'string',
          description: 'The specific question or request for the specialist',
        },
        athlete_context: {
          type: 'object',
          description: 'Relevant athlete context to pass to the specialist (current metrics, recent activities, etc.)',
        },
      },
      required: ['specialist', 'query'],
    },
  },
  get_training_data: {
    handler: getTrainingData,
    label: 'Pulling training data',
    description:
      'Retrieve training activities with power, HR, TSS data. Supports date ranges for historical lookups. Can retrieve detailed lap splits for a specific activity. For stream-level analysis (HR drift, power distribution, time-in-zones), use analyze_activity instead.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days of history to retrieve (from today). Default 7. Ignored if start_date is provided.',
        },
        start_date: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD) for the start of a date range. Use with end_date for historical queries like "show me January rides".',
        },
        end_date: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD) for the end of a date range. Defaults to now if omitted.',
        },
        type: {
          type: 'string',
          // Spread from ACTIVITY_TYPES rather than restated: what the model is
          // told it may send and what the handler's zod schema accepts are the
          // same list, so they cannot drift into the model being offered a
          // value the tool rejects.
          enum: [...ACTIVITY_TYPES],
          description: 'Filter by activity type',
        },
        include_plan: {
          type: 'boolean',
          description: 'Include upcoming planned sessions. Default true.',
        },
        include_laps: {
          type: 'boolean',
          description: 'Include lap splits for each activity (only with activity_id). Default false.',
        },
        activity_id: {
          type: 'string',
          description: 'Get detailed data for a specific activity by ID. Returns laps if requested.',
        },
        limit: {
          type: 'number',
          description: 'Max number of activities to return. Default 50, max 100.',
        },
      },
    },
  },
  analyze_activity: {
    handler: analyzeActivity,
    label: 'Analyzing activity data',
    description:
      'Deep analysis of a single activity using stream data. Returns computed metrics: power zones distribution, HR drift & cardiac drift, normalized power, variability index, and power/HR by thirds. For single-lap activities (e.g. races), automatically includes downsampled power/HR curves (~120 points). Use when the athlete asks about pacing, drift, zone distribution, or wants a detailed ride analysis. Requires activity_id — use get_training_data first to find it.',
    input_schema: {
      type: 'object',
      properties: {
        activity_id: {
          type: 'string',
          description: 'The activity ID to analyze',
        },
        include_downsampled: {
          type: 'boolean',
          description: 'Include downsampled power/HR/cadence arrays (~120 points). Auto-included for single-lap activities. Default false.',
        },
      },
      required: ['activity_id'],
    },
  },
  get_body_metrics: {
    handler: getBodyMetrics,
    label: 'Analyzing body metrics',
    description:
      'Retrieve athlete body metrics and readiness status. Returns weight, FTP, and TSB-based readiness (CTL/ATL/TSB). Note: Wahoo does not provide sleep or HRV data — readiness is derived from training load balance.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  get_nutrition_log: {
    handler: getNutritionLog,
    label: 'Checking nutrition',
    description: 'Retrieve nutrition logs for a specific date or date range. Returns meals logged and macro totals.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD). Defaults to today.',
        },
        days: {
          type: 'number',
          description: 'Number of days to retrieve. Default 1 (single day detail).',
        },
      },
    },
  },
  log_meal: {
    handler: logMeal,
    label: 'Logging meal',
    description:
      "Log a meal the athlete describes. Estimate macros from the description if the athlete doesn't provide exact values. Set confidence_tier: 1 for weighed/labeled food, 2 for photo-confirmed, 3 for description-based estimate.",
    input_schema: {
      type: 'object',
      properties: {
        meal_type: {
          type: 'string',
          enum: [...MEAL_TYPES],
          description: 'Type of meal',
        },
        description: {
          type: 'string',
          description: 'What the athlete ate, as described',
        },
        calories: { type: 'number', description: 'Estimated calories' },
        carbs_g: { type: 'number', description: 'Estimated carbs in grams' },
        protein_g: { type: 'number', description: 'Estimated protein in grams' },
        fat_g: { type: 'number', description: 'Estimated fat in grams' },
        confidence_tier: {
          type: 'number',
          enum: [...CONFIDENCE_TIERS],
          description: 'Accuracy tier: 1=precision (weighed/label), 2=visual (photo), 3=estimate (description)',
        },
      },
      required: ['description'],
    },
  },
  log_session_feedback: {
    handler: logSessionFeedback,
    label: 'Logging session feedback',
    description:
      'Record the athlete\'s feedback on a completed training session. Use after they report how a workout went.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'UUID of the plan_session to log feedback for',
        },
        rpe: {
          type: 'number',
          description: 'Rate of Perceived Exertion (1-10)',
        },
        notes: {
          type: 'string',
          description: "Athlete's feedback notes",
        },
        completed: {
          type: 'boolean',
          description: 'Whether the session was completed. Default true.',
        },
      },
      required: ['session_id', 'rpe'],
    },
  },
  update_training_plan: {
    handler: updateTrainingPlan,
    label: 'Updating training plan',
    description:
      'Create a new training plan, add sessions to an existing plan, or update plan metadata. Always confirm the plan with the athlete before creating. For multi-week plans, do NOT try to write every session in one call — batch add_sessions calls by week (or ~5-10 sessions at a time) across multiple turns. A single call with a large sessions array risks being cut off by the output token limit before the sessions array is even reached, silently dropping it.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...PLAN_ACTIONS],
          description: 'What action to take',
        },
        plan_id: {
          type: 'string',
          description: 'UUID of existing plan (for update or add_sessions)',
        },
        name: { type: 'string', description: 'Plan name' },
        start_date: { type: 'string', description: 'ISO date for plan start' },
        end_date: { type: 'string', description: 'ISO date for plan end' },
        phase: {
          type: 'string',
          enum: [...TRAINING_PHASES],
          description: 'Training phase',
        },
        methodology: { type: 'string', description: 'Training methodology' },
        weekly_tss_target: { type: 'number', description: 'Weekly TSS target' },
        weekly_hours_target: { type: 'number', description: 'Weekly hours target' },
        notes: { type: 'string' },
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scheduled_date: { type: 'string', description: 'ISO date' },
              session_type: { type: 'string', enum: [...SESSION_TYPES] },
              title: { type: 'string' },
              description: { type: 'string' },
              target_tss: { type: 'number' },
              target_duration_min: { type: 'number' },
              target_if: { type: 'number' },
              intervals: {
                type: 'array',
                description:
                  'Structured workout steps, in order. Required to push the session to the athlete\'s head unit. All power values are fractions of FTP, not watts.',
                // The item shape has to be here. Without it the model invents
                // a format on every call, and a session with the wrong field
                // names stores fine and becomes a silently wrong workout on the
                // device.
                items: PLAN_INTERVAL_JSON_SCHEMA,
              },
            },
            required: ['scheduled_date', 'session_type', 'title'],
          },
        },
      },
      required: ['action'],
    },
  },
  update_ftp_and_zones: {
    handler: updateFtpZones,
    label: 'Updating FTP & zones',
    description:
      'Update the athlete\'s FTP and recompute all power zones. Always confirm the new value with the athlete before calling. Use when: athlete completes an FTP test, reports a new FTP, ride data suggests FTP change, or periodic reassessment is due.',
    input_schema: {
      type: 'object',
      properties: {
        ftp: { type: 'number', description: 'New FTP in watts' },
        ftp_source: {
          type: 'string',
          enum: [...FTP_SOURCES],
          description: 'How the FTP was determined',
        },
        push_to_device: {
          type: 'boolean',
          description: 'Whether to push updated zones to Wahoo ELEMNT',
        },
        reason: {
          type: 'string',
          description: 'Brief note on why zones are changing',
        },
      },
      required: ['reason'],
    },
  },
  update_athlete_profile: {
    handler: updateAthleteProfile,
    label: 'Updating profile',
    description:
      "Update the athlete's profile data. Use when the athlete shares personal info (weight, age, height, available hours, experience level, goals). Save immediately so it persists across sessions. Does NOT require confirmation — just save what they tell you. Also updates daily_calorie_adjustment when the athlete sets a calorie goal (deficit, surplus, or maintenance).",
    input_schema: {
      type: 'object',
      properties: {
        weight_kg: { type: 'number', description: 'Body weight in kg' },
        height_cm: { type: 'number', description: 'Height in cm' },
        age: { type: 'number', description: 'Age in years' },
        sex: { type: 'string', enum: [...SEXES], description: 'Biological sex' },
        available_hours_week: { type: 'number', description: 'Hours available for training per week' },
        experience_level: {
          type: 'string',
          enum: [...EXPERIENCE_LEVELS],
          description: 'Cycling experience level',
        },
        primary_goal: {
          type: 'string',
          enum: [...PRIMARY_GOALS],
          description: 'Primary training goal',
        },
        coaching_tone: {
          type: 'number',
          description: 'Coaching tone preference 1-10 (1=gentle, 10=demanding)',
        },
        daily_calorie_adjustment: {
          type: 'number',
          description: 'Daily calorie adjustment in kcal. Negative = deficit (weight loss), positive = surplus (fuelling/gain), 0 = maintenance. Applied on top of BMR to set the daily calorie target.',
        },
      },
    },
  },
  save_target_event: {
    handler: saveTargetEvent,
    label: 'Saving event',
    description:
      "Add or remove a target event/race from the athlete's calendar. Use when the athlete mentions a race or event they're training for. Save immediately — does NOT require confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...EVENT_ACTIONS],
          description: 'Whether to add or remove the event',
        },
        name: { type: 'string', description: 'Event name (e.g., "The Traka 100")' },
        event_date: { type: 'string', description: 'ISO date (YYYY-MM-DD). Required for add.' },
        event_type: {
          type: 'string',
          enum: [...EVENT_TYPES],
          description: 'Type of event',
        },
        priority: {
          type: 'string',
          enum: [...EVENT_PRIORITIES],
          description: 'Event priority. A=peak performance target, B=important but not primary, C=for fun/training',
        },
      },
      required: ['action', 'name'],
    },
  },
  save_coaching_note: {
    handler: saveCoachingNote,
    label: 'Saving note',
    description:
      "Save a coaching note for future reference. Use when the athlete mentions something worth remembering that doesn't fit structured data: preferences, temporary constraints, health observations, schedule quirks, fueling experiments, decisions in progress. Notes persist across sessions and appear in the context preamble. Does NOT require confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The note content. Be concise and factual.',
        },
        category: {
          type: 'string',
          enum: [...NOTE_CATEGORIES],
          description: 'Category of the note',
        },
        expires_in_days: {
          type: 'number',
          description: 'Optional: auto-expire the note after N days. Use for temporary things like "bikepacking trip next weekend" or "taking antibiotics this week".',
        },
      },
      required: ['content'],
    },
  },
  get_coaching_notes: {
    handler: getCoachingNotes,
    label: 'Reading notes',
    description:
      "Retrieve all active coaching notes for the athlete. Notes are already included in the context preamble, so only call this if you need the full list or to check for specific notes.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  push_workout_to_device: {
    handler: pushWorkoutToDevice,
    label: 'Pushing workout to device',
    description:
      'Send a structured workout to the athlete\'s Wahoo ELEMNT device. The workout appears on the device for the scheduled ride.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'UUID of the plan_session containing the workout intervals',
        },
      },
      required: ['session_id'],
    },
  },
} satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOL_REGISTRY;

export const TOOL_NAMES = Object.keys(TOOL_REGISTRY) as ToolName[];

/** The JSON Schema view of the registry, as Claude's API wants it. */
export const ALL_TOOL_DEFINITIONS: ToolDefinition[] = Object.entries(TOOL_REGISTRY).map(
  ([name, spec]) => ({
    name,
    description: spec.description,
    input_schema: spec.input_schema,
  }),
);

export const ALL_TOOL_HANDLERS: Record<ToolName, ToolHandler> = Object.fromEntries(
  Object.entries(TOOL_REGISTRY).map(([name, spec]) => [name, spec.handler]),
) as Record<ToolName, ToolHandler>;
