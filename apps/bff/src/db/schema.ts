import { sqliteTable, text, integer, real, unique, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// SQLite has no native uuid/decimal/jsonb/boolean/timestamp types — Drizzle's
// sqlite-core maps them: text() for uuid/varchar, real() for decimals,
// text({mode:'json'}) for jsonb (auto (de)serializes, call sites unchanged),
// integer({mode:'boolean'}) for booleans, integer({mode:'timestamp'}) for
// timestamps (kept as JS Date on the app side, call sites unchanged).

const uuidPk = () => text('id').primaryKey().$defaultFn(() => randomUUID());
const uuidRef = (name: string) => text(name);
const timestamptz = (name: string) => integer(name, { mode: 'timestamp' });
const dateCol = (name: string) => text(name); // ISO date string 'YYYY-MM-DD', unchanged from pg `date`

export const athletes = sqliteTable('athletes', {
  id: uuidPk(),
  name: text('name').notNull(),
  email: text('email'),
  timezone: text('timezone').notNull().default('Europe/Madrid'),
  ftp: integer('ftp'),
  ftpUpdatedAt: timestamptz('ftp_updated_at'),
  weightKg: real('weight_kg'),
  heightCm: integer('height_cm'),
  age: integer('age'),
  sex: text('sex'),
  availableHoursWeek: real('available_hours_week'),
  experienceLevel: text('experience_level'),
  primaryGoal: text('primary_goal'),
  coachingTone: integer('coaching_tone').notNull().default(5),
  createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
});

export const targetEvents = sqliteTable('target_events', {
  id: uuidPk(),
  athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
  name: text('name').notNull(),
  eventDate: dateCol('event_date').notNull(),
  eventType: text('event_type'),
  priority: text('priority').default('A'),
  createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
});

export const activities = sqliteTable(
  'activities',
  {
    id: uuidPk(),
    athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
    source: text('source').notNull().default('wahoo'),
    externalId: text('external_id'),
    type: text('type').notNull(),
    name: text('name'),
    startedAt: timestamptz('started_at').notNull(),
    durationS: integer('duration_s').notNull(),
    distanceM: real('distance_m'),
    avgPower: integer('avg_power'),
    normPower: integer('norm_power'),
    maxPower: integer('max_power'),
    avgHr: integer('avg_hr'),
    maxHr: integer('max_hr'),
    avgCadence: integer('avg_cadence'),
    elevationM: real('elevation_m'),
    calories: integer('calories'),
    tss: real('tss'),
    intensityFactor: real('intensity_factor'),
    fitFileUrl: text('fit_file_url'),
    createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    uniqExternal: unique().on(t.athleteId, t.source, t.externalId),
    dateIdx: index('idx_activities_date').on(t.athleteId, t.startedAt),
  }),
);

export const activityLaps = sqliteTable(
  'activity_laps',
  {
    id: uuidPk(),
    activityId: uuidRef('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
    lapIndex: integer('lap_index').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    durationS: integer('duration_s').notNull(),
    distanceM: real('distance_m'),
    avgPower: integer('avg_power'),
    maxPower: integer('max_power'),
    normPower: integer('norm_power'),
    avgHr: integer('avg_hr'),
    maxHr: integer('max_hr'),
    avgCadence: integer('avg_cadence'),
    avgSpeed: real('avg_speed'),
    elevationGain: real('elevation_gain'),
    calories: integer('calories'),
  },
  (t) => ({ lapIdx: index('idx_laps_activity').on(t.activityId, t.lapIndex) }),
);

export const activityStreams = sqliteTable(
  'activity_streams',
  {
    id: uuidPk(),
    activityId: uuidRef('activity_id').notNull().references(() => activities.id, { onDelete: 'cascade' }),
    timestamps: text('timestamps', { mode: 'json' }).$type<number[]>(),
    power: text('power', { mode: 'json' }).$type<(number | null)[]>(),
    heartRate: text('heart_rate', { mode: 'json' }).$type<(number | null)[]>(),
    cadence: text('cadence', { mode: 'json' }).$type<(number | null)[]>(),
    speed: text('speed', { mode: 'json' }).$type<(number | null)[]>(),
    altitude: text('altitude', { mode: 'json' }).$type<(number | null)[]>(),
    distance: text('distance', { mode: 'json' }).$type<(number | null)[]>(),
    temperature: text('temperature', { mode: 'json' }).$type<(number | null)[]>(),
    lat: text('lat', { mode: 'json' }).$type<(number | null)[]>(),
    lng: text('lng', { mode: 'json' }).$type<(number | null)[]>(),
    sampleCount: integer('sample_count').notNull().default(0),
  },
  (t) => ({ uniqActivity: unique().on(t.activityId) }),
);

export const dailyMetrics = sqliteTable(
  'daily_metrics',
  {
    id: uuidPk(),
    athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
    date: dateCol('date').notNull(),
    dailyTss: real('daily_tss').notNull().default(0),
    ctl: real('ctl'),
    atl: real('atl'),
    tsb: real('tsb'),
    rampRate: real('ramp_rate'),
    createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    uniqDate: unique().on(t.athleteId, t.date),
    dateIdx: index('idx_metrics_date').on(t.athleteId, t.date),
  }),
);

export const powerZones = sqliteTable('power_zones', {
  id: uuidPk(),
  athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
  ftp: integer('ftp').notNull(),
  zones: text('zones', { mode: 'json' }).notNull().$type<Array<{ zone: number; name: string; minWatts: number; maxWatts: number }>>(),
  source: text('source').notNull(),
  reason: text('reason'),
  createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
});

export const trainingPlans = sqliteTable('training_plans', {
  id: uuidPk(),
  athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
  name: text('name').notNull(),
  startDate: dateCol('start_date').notNull(),
  endDate: dateCol('end_date'),
  phase: text('phase'),
  methodology: text('methodology'),
  weeklyTssTarget: integer('weekly_tss_target'),
  weeklyHoursTarget: real('weekly_hours_target'),
  notes: text('notes'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
});

export const planSessions = sqliteTable(
  'plan_sessions',
  {
    id: uuidPk(),
    planId: uuidRef('plan_id').notNull().references(() => trainingPlans.id, { onDelete: 'cascade' }),
    athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
    scheduledDate: dateCol('scheduled_date').notNull(),
    sessionType: text('session_type').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    targetTss: integer('target_tss'),
    targetDurationMin: integer('target_duration_min'),
    targetIf: real('target_if'),
    intervals: text('intervals', { mode: 'json' }).$type<unknown[]>(),
    completed: integer('completed', { mode: 'boolean' }).default(false),
    activityId: uuidRef('activity_id').references(() => activities.id),
    feedbackRpe: integer('feedback_rpe'),
    feedbackNotes: text('feedback_notes'),
    wahooPlanId: integer('wahoo_plan_id'),
    createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => ({ dateIdx: index('idx_sessions_date').on(t.athleteId, t.scheduledDate) }),
);

export const nutritionLogs = sqliteTable(
  'nutrition_logs',
  {
    id: uuidPk(),
    athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
    date: dateCol('date').notNull(),
    loggedAt: timestamptz('logged_at').notNull().default(sql`(unixepoch())`),
    mealType: text('meal_type'),
    confidenceTier: integer('confidence_tier').notNull().default(3),
    description: text('description').notNull(),
    calories: real('calories'),
    carbsG: real('carbs_g'),
    proteinG: real('protein_g'),
    fatG: real('fat_g'),
    source: text('source').default('chat'),
    createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => ({ dateIdx: index('idx_nutrition_date').on(t.athleteId, t.date) }),
);

export const personalBests = sqliteTable(
  'personal_bests',
  {
    id: uuidPk(),
    athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
    best1s: integer('best_1s'),
    best3s: integer('best_3s'),
    best10s: integer('best_10s'),
    best30s: integer('best_30s'),
    best1min: integer('best_1min'),
    best5min: integer('best_5min'),
    best10min: integer('best_10min'),
    best15min: integer('best_15min'),
    best20min: integer('best_20min'),
    best30min: integer('best_30min'),
    best1hr: integer('best_1hr'),
    best2hr: integer('best_2hr'),
    maxHr: integer('max_hr'),
    updatedAt: timestamptz('updated_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => ({ uniqAthlete: unique().on(t.athleteId) }),
);

export const wahooConnections = sqliteTable(
  'wahoo_connections',
  {
    id: uuidPk(),
    athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
    wahooUserId: text('wahoo_user_id').notNull(),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    tokenExpiresAt: timestamptz('token_expires_at').notNull(),
    scopes: text('scopes'),
    lastSyncAt: timestamptz('last_sync_at'),
    createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => ({ uniqAthlete: unique().on(t.athleteId) }),
);

export const coachingNotes = sqliteTable(
  'coaching_notes',
  {
    id: uuidPk(),
    athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
    category: text('category').notNull().default('general'),
    content: text('content').notNull(),
    expiresAt: timestamptz('expires_at'),
    createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => ({ athleteIdx: index('idx_notes_athlete').on(t.athleteId, t.createdAt) }),
);

export const knowledgeGaps = sqliteTable('knowledge_gaps', {
  id: uuidPk(),
  specialist: text('specialist').notNull(),
  topic: text('topic').notNull(),
  query: text('query').notNull(),
  timesHit: integer('times_hit').notNull().default(1),
  firstSeen: timestamptz('first_seen').notNull().default(sql`(unixepoch())`),
  lastSeen: timestamptz('last_seen').notNull().default(sql`(unixepoch())`),
});

// ── New tables (a prior hosted version held these server-side; now ours to store) ──

export const chats = sqliteTable('chats', {
  id: uuidPk(),
  athleteId: uuidRef('athlete_id').notNull().references(() => athletes.id),
  title: text('title'),
  createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
});

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: uuidPk(),
    chatId: uuidRef('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // 'user' | 'assistant' — matches Anthropic's MessageParam roles
    // Anthropic content: a string, or an array of content blocks (text /
    // tool_use / tool_result). Stored as JSON either way so a row maps
    // directly to one MessageParam with no reshaping.
    content: text('content', { mode: 'json' }).notNull().$type<string | unknown[]>(),
    createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => ({ chatIdx: index('idx_messages_chat').on(t.chatId, t.createdAt) }),
);

// ── Knowledge base retrieval (§8 of the plan — embeddings stored as JSON,
// cosine similarity computed in JS; no vector extension needed at this scale) ──

export const kbChunks = sqliteTable(
  'kb_chunks',
  {
    id: uuidPk(),
    vertical: text('vertical').notNull(), // cycling_coach | nutritionist | strength_conditioning | recovery
    sourceFile: text('source_file').notNull(),
    chunkText: text('chunk_text').notNull(),
    embedding: text('embedding', { mode: 'json' }).notNull().$type<number[]>(),
    createdAt: timestamptz('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => ({ verticalIdx: index('idx_chunks_vertical').on(t.vertical) }),
);
