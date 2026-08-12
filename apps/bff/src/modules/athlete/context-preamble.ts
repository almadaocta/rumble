import { db } from '../../db/client.js';
import { athletes, activities, dailyMetrics, planSessions, trainingPlans, targetEvents, coachingNotes } from '../../db/schema.js';
import { eq, desc, and, or, isNull, gt, gte, lte, sql } from 'drizzle-orm';
import { formLabel } from '../metrics/training-load.js';
import { formatDuration, utcDateString } from '../../lib/format.js';
import { PINNED_NOTE_CATEGORIES } from '../tools/vocabularies.js';

/*
 * Deliberately uncached, and it should stay that way.
 *
 * A per-athlete TTL cache here needs every writer in the app to invalidate it —
 * a contract carried by convention across 24 call sites, and one that was missed
 * three separate times: the coach told athletes their finished session was still
 * outstanding, quoted the previous day's form after the overnight rollup, and
 * served a plan a tool had just rewritten.
 *
 * With a year of data seeded (400 activities, 400 daily metrics) a full build is
 * 0.73 ms, against an LLM call measured in seconds. There is no millisecond here
 * worth an entire class of staleness bug.
 *
 * If it ever does need caching, key it on a freshness stamp — MAX(updated_at)
 * across the source tables — so staleness cannot survive a write.
 */
/**
 * The four datasets the slim preamble renders.
 *
 * Separate from fetchAthleteData, which returns seven. This runs on every chat
 * turn and reads only these four; serving it from the wider fetch means three
 * queries per turn — recent activities, target events and weekly TSS — whose
 * results are thrown away.
 *
 * Coaching notes are fetched here (not just via the on-demand
 * get_athlete_context/get_coaching_notes tools) so durable athlete history
 * survives a brand new chat thread — a fresh chatId has no message history of
 * its own, and without this the model only sees that history if it happens to
 * call a tool for it. Only PINNED_NOTE_CATEGORIES render in full in the
 * preamble though (see buildSlimPreamble); the rest render as a one-line
 * index, since sending every note in full would grow the preamble unbounded
 * as a season's worth of notes accumulates.
 */
async function fetchSlimAthleteData(athleteId: string) {
  // The athlete row has to resolve first — "today" depends on their
  // timezone, and querying planSessions before that's known previously
  // defaulted to the UTC calendar date, which is the wrong day for a chunk
  // of every 24 hours in any non-UTC timezone.
  const [athlete] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athlete) return { profile: undefined, latestMetrics: [], todaySessions: [], activeNotes: [] };

  const todayStr = isoDateInTimezone(new Date(), athlete.timezone || 'UTC');

  const [latestMetrics, todaySessions, activeNotes] = await Promise.all([
    db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.athleteId, athleteId))
      .orderBy(desc(dailyMetrics.date))
      .limit(1),
    getSessionsForDate(athleteId, todayStr),
    getActiveCoachingNotes(athleteId),
  ]);

  return { profile: athlete, latestMetrics, todaySessions, activeNotes };
}

async function getActiveCoachingNotes(athleteId: string) {
  const now = new Date();
  return db
    .select()
    .from(coachingNotes)
    .where(
      and(
        eq(coachingNotes.athleteId, athleteId),
        or(isNull(coachingNotes.expiresAt), gt(coachingNotes.expiresAt, now)),
      ),
    )
    .orderBy(desc(coachingNotes.createdAt));
}

/** The full set, for the detailed context the get_athlete_context tool returns. */
async function fetchAthleteData(athleteId: string) {
  // Same ordering constraint as fetchSlimAthleteData: "today" needs the
  // athlete's timezone before planSessions can be queried for it.
  const [athlete] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athlete) {
    return {
      profile: undefined,
      recentActivities: [],
      latestMetrics: [],
      todaySessions: [],
      events: [],
      weeklyTss: { current: 0, target: null },
      notes: [],
    };
  }

  const todayStr = isoDateInTimezone(new Date(), athlete.timezone || 'UTC');

  const [recentActivities, latestMetrics, todaySessions, events, weeklyTss, notes] =
    await Promise.all([
      db
        .select()
        .from(activities)
        .where(eq(activities.athleteId, athleteId))
        .orderBy(desc(activities.startedAt))
        .limit(3),
      db
        .select()
        .from(dailyMetrics)
        .where(eq(dailyMetrics.athleteId, athleteId))
        .orderBy(desc(dailyMetrics.date))
        .limit(1),
      getSessionsForDate(athleteId, todayStr),
      // Future events only, soonest first. Without both, this returns the
      // earliest row on file — a race from last season — which the caller
      // renders as "Next event: X in 200 days". athlete.controller.ts filters
      // the same table this way for /stats.
      db
        .select()
        .from(targetEvents)
        .where(
          and(
            eq(targetEvents.athleteId, athleteId),
            gte(targetEvents.eventDate, utcDateString()),
          ),
        )
        .orderBy(targetEvents.eventDate)
        .limit(1),
      getWeeklyTss(athleteId),
      db
        .select()
        .from(coachingNotes)
        .where(eq(coachingNotes.athleteId, athleteId))
        .orderBy(desc(coachingNotes.createdAt))
        .limit(15),
    ]);

  return { profile: athlete, recentActivities, latestMetrics, todaySessions, events, weeklyTss, notes };
}

/**
 * Slim preamble sent on every LLM call: time, identity, current form, today's
 * plan, tone, plus coaching notes. The fixed fields stay ~100-150 tokens.
 * Notes are two-tiered rather than dumped in full: PINNED_NOTE_CATEGORIES
 * (health/constraint/preference) render completely, since they're safety- or
 * identity-critical regardless of what the conversation is about. Everything
 * else renders as a per-category count — a table of contents pointing at
 * get_coaching_notes({ category }) — so per-turn cost stays roughly constant
 * as a season's worth of decisions/observations/nutrition notes accumulates,
 * instead of growing with the athlete's entire history.
 */
export async function buildSlimPreamble(athleteId: string): Promise<string> {
  const data = await fetchSlimAthleteData(athleteId);
  if (!data.profile) return '';

  const now = new Date();
  const tz = data.profile.timezone || 'UTC';
  const lines: string[] = [];

  // ISO date, not just the human-readable line below: every tool that takes a
  // date (scheduled_date, start_date, ...) wants YYYY-MM-DD, and every one of
  // those dates the model writes for a session more than a day out is
  // computed from this anchor. A weekday name alone forces the model to do
  // that arithmetic in its head across a multi-week plan, which is exactly
  // where dates drift by a day.
  //
  // Deliberately not utcDateString(now) — that's the UTC calendar date, which
  // near midnight can be a day off from the athlete's own. An athlete at
  // 11pm local in a timezone ahead of UTC is already "tomorrow" in UTC; this
  // anchor has to match the calendar the athlete and every session date on
  // it actually live on.
  lines.push(`Today: ${isoDateInTimezone(now, tz)} (${now.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz })})`);
  lines.push(`Current time: ${formatInTimezone(now, tz)}`);
  lines.push(`Timezone: ${tz}`);

  lines.push(`Athlete: ${data.profile.name}`);
  if (data.profile.ftp) {
    const wpkg = data.profile.weightKg
      ? ` (${(data.profile.ftp / Number(data.profile.weightKg)).toFixed(2)} W/kg)`
      : '';
    lines.push(`FTP: ${data.profile.ftp}W${wpkg}`);
  }

  const metrics = data.latestMetrics[0];
  if (metrics) {
    const tsb = Number(metrics.tsb ?? 0);
    const form = formLabel(tsb);
    lines.push(`TSB: ${tsb > 0 ? '+' : ''}${tsb} (${form})`);
  }

  if (data.todaySessions.length > 0) {
    const summary = data.todaySessions
      .map((s) => `${s.title}${s.completed ? ' done' : ''}`)
      .join(', ');
    lines.push(`Today: ${summary}`);
  } else {
    lines.push('Today: Rest day');
  }

  lines.push(`Coaching tone: ${data.profile.coachingTone}/10`);

  const pinnedNotes = data.activeNotes.filter((n) =>
    (PINNED_NOTE_CATEGORIES as readonly string[]).includes(n.category),
  );
  const archivedNotes = data.activeNotes.filter(
    (n) => !(PINNED_NOTE_CATEGORIES as readonly string[]).includes(n.category),
  );

  if (pinnedNotes.length > 0) {
    lines.push('');
    lines.push('Coaching notes (durable athlete history — read these before asking things you may already know):');
    for (const note of pinnedNotes) {
      lines.push(`- [${note.category}] ${note.content}`);
    }
  }

  if (archivedNotes.length > 0) {
    lines.push('');
    lines.push(
      `Archived coaching notes: ${archivedNotes.length} more (${categoryCounts(archivedNotes)}) — ` +
        'call get_coaching_notes({ category }) if the current topic needs that history.',
    );
  }

  return lines.join('\n');
}

function categoryCounts(notes: Array<{ category: string }>): string {
  const counts = new Map<string, number>();
  for (const n of notes) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
  return [...counts.entries()].map(([category, count]) => `${category}: ${count}`).join(', ');
}

/**
 * Detailed context returned by the get_athlete_context tool on demand.
 * Contains recent activities, coaching notes, goals, fitness trends, etc.
 */
export async function buildDetailedContext(athleteId: string): Promise<string> {
  const data = await fetchAthleteData(athleteId);
  if (!data.profile) return '';

  const now = new Date();
  const lines: string[] = [];

  if (data.events[0]) {
    const daysUntil = daysBetween(now, new Date(data.events[0].eventDate));
    lines.push(`Next event: ${data.events[0].name} in ${daysUntil} days`);
  }

  lines.push('');
  lines.push('Athlete profile:');
  if (data.profile.weightKg) lines.push(`- Weight: ${data.profile.weightKg} kg`);
  if (data.profile.experienceLevel) lines.push(`- Experience: ${data.profile.experienceLevel}`);
  if (data.profile.primaryGoal) lines.push(`- Goal: ${data.profile.primaryGoal}`);
  if (data.profile.availableHoursWeek) lines.push(`- Available hours/week: ${data.profile.availableHoursWeek}`);
  if (data.profile.ftp && data.profile.ftpUpdatedAt) {
    const ftpAge = daysBetween(data.profile.ftpUpdatedAt, now);
    if (ftpAge > 42) {
      lines.push(`- FTP last updated ${ftpAge} days ago — consider reassessment`);
    }
  }

  const metrics = data.latestMetrics[0];
  if (metrics) {
    lines.push('');
    lines.push('Fitness metrics:');
    lines.push(`- CTL: ${metrics.ctl ?? '?'} / ATL: ${metrics.atl ?? '?'}`);
    // `!= null`, not truthiness: a ramp rate of 0 means fitness is holding flat,
    // which is a real coaching signal, and truthiness drops the line entirely.
    if (metrics.rampRate != null) lines.push(`- Ramp rate: ${metrics.rampRate} pts/week`);
  }

  lines.push(
    `- Weekly TSS so far: ${data.weeklyTss.current}` +
      (data.weeklyTss.target != null ? ` / target: ${data.weeklyTss.target}` : ''),
  );

  if (data.recentActivities.length > 0) {
    lines.push('');
    lines.push('Recent activities:');
    for (const act of data.recentActivities) {
      const ago = relativeDate(new Date(act.startedAt));
      const power = act.avgPower ? `, ${act.avgPower}W avg` : '';
      const tss = act.tss ? `, ${act.tss} TSS` : '';
      lines.push(`- ${act.name || act.type} (${ago}): ${formatDuration(act.durationS)}${power}${tss}`);
    }
  }

  if (data.todaySessions.length > 0) {
    lines.push('');
    lines.push("Today's plan:");
    for (const s of data.todaySessions) {
      const dur = s.targetDurationMin ? ` — ${s.targetDurationMin} min` : '';
      const tss = s.targetTss ? `, ~${s.targetTss} TSS` : '';
      const status = s.completed ? ' ✓ done' : '';
      lines.push(`- ${s.title} (${s.sessionType})${dur}${tss}${status}`);
    }
  }

  const activeNotes = data.notes.filter(
    (n) => !n.expiresAt || new Date(n.expiresAt) > now,
  );
  if (activeNotes.length > 0) {
    lines.push('');
    lines.push('Coaching notes:');
    for (const note of activeNotes) {
      const label = note.category !== 'general' ? `[${note.category}] ` : '';
      const expires = note.expiresAt
        ? ` (expires ${new Date(note.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
        : '';
      lines.push(`- ${label}${note.content}${expires}`);
    }
  }

  return lines.join('\n');
}

// Takes the date string directly, not a Date + timezone, so it can never
// silently fall back to a UTC calendar date — the caller must have already
// resolved the athlete's actual local day before this runs. Getting this
// wrong is exactly how a session lands on the model's "today" for the wrong
// day near a timezone's midnight (see buildSlimPreamble).
async function getSessionsForDate(athleteId: string, dateStr: string) {
  return db
    .select()
    .from(planSessions)
    .where(and(eq(planSessions.athleteId, athleteId), eq(planSessions.scheduledDate, dateStr)))
    .orderBy(planSessions.scheduledDate);
}

/**
 * Week-to-date TSS and the active plan's target, if there is one.
 *
 * Not nullable: the COALESCE makes `current` always a number and the target is
 * already `number | null`, so there is no path that returns null. The old
 * signature said otherwise, which put a `!== null` branch in the caller that
 * could never run.
 */
async function getWeeklyTss(athleteId: string): Promise<{ current: number; target: number | null }> {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const mondayStr = utcDateString(monday);
  const todayStr = utcDateString(now);

  const result = await db
    .select({ total: sql<string>`COALESCE(SUM(${dailyMetrics.dailyTss}), 0)` })
    .from(dailyMetrics)
    .where(
      and(
        eq(dailyMetrics.athleteId, athleteId),
        gte(dailyMetrics.date, mondayStr),
        lte(dailyMetrics.date, todayStr),
      ),
    );

  const activePlan = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.athleteId, athleteId), eq(trainingPlans.isActive, true)))
    .limit(1);

  return {
    current: Math.round(Number(result[0]?.total ?? 0)),
    target: activePlan[0]?.weeklyTssTarget ?? null,
  };
}

/** `en-CA` formats as YYYY-MM-DD natively — the one locale where that's the default, not a manual reassembly. */
function isoDateInTimezone(date: Date, tz: string): string {
  return date.toLocaleDateString('en-CA', { timeZone: tz });
}

function formatInTimezone(date: Date, tz: string): string {
  return date.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Signed day count from `from` to `to` — negative means `to` is in the past.
 *
 * Signed on purpose. Both callers read the result as a direction ("in N days",
 * "N days ago"), so a Math.abs here makes the wrong direction indistinguishable
 * from the right one — which is how a race from last season reads as "Next
 * event: X in 200 days".
 */
function daysBetween(from: Date | string, to: Date | string): number {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function relativeDate(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

