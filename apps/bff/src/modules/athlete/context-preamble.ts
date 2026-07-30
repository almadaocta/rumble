import { db } from '../../db/client.js';
import { athletes, activities, dailyMetrics, planSessions, trainingPlans, targetEvents, coachingNotes } from '../../db/schema.js';
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import { formLabel } from '../metrics/training-load.js';
import { formatDuration, utcDateString } from '../../lib/format.js';

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
 * The three datasets the slim preamble renders.
 *
 * Separate from fetchAthleteData, which returns seven. This runs on every chat
 * turn and reads only these three; serving it from the wider fetch means four
 * queries per turn — recent activities, target events, weekly TSS and coaching
 * notes — whose results are thrown away.
 */
async function fetchSlimAthleteData(athleteId: string) {
  const [athlete, latestMetrics, todaySessions] = await Promise.all([
    db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1),
    db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.athleteId, athleteId))
      .orderBy(desc(dailyMetrics.date))
      .limit(1),
    getSessionsForDate(athleteId, new Date()),
  ]);

  return { profile: athlete[0], latestMetrics, todaySessions };
}

/** The full set, for the detailed context the get_athlete_context tool returns. */
async function fetchAthleteData(athleteId: string) {
  const [athlete, recentActivities, latestMetrics, todaySessions, events, weeklyTss, notes] =
    await Promise.all([
      db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1),
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
      getSessionsForDate(athleteId, new Date()),
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

  return { profile: athlete[0], recentActivities, latestMetrics, todaySessions, events, weeklyTss, notes };
}

/**
 * Slim preamble (~100-150 tokens) sent on every LLM call.
 * Contains only the essentials: time, identity, current form, today's plan, tone.
 */
export async function buildSlimPreamble(athleteId: string): Promise<string> {
  const data = await fetchSlimAthleteData(athleteId);
  if (!data.profile) return '';

  const now = new Date();
  const tz = data.profile.timezone || 'UTC';
  const lines: string[] = [];

  lines.push(`Current time: ${formatInTimezone(now, tz)}`);
  lines.push(`Timezone: ${tz}`);
  lines.push(`Day: ${now.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz })}`);

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

  return lines.join('\n');
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

async function getSessionsForDate(athleteId: string, date: Date) {
  const dateStr = utcDateString(date);
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

