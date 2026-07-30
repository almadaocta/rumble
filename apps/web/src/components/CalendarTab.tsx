import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { SessionIcon, ActivityIcon } from '@/components/shared';
import { DataSourceControls } from '@/components/DataSourceControls';
import { cn } from '@/lib/utils';
import { mergeDays, buildMonthGrid, localDateKey, type DayData as LibDayData } from '@/lib/calendar';
import { getJson } from '@/lib/api';

import type {
  PlanSession as Session,
  Activity,
  ActivityFull,
} from '@/lib/api-types';

const SESSION_COLORS: Record<string, string> = {
  endurance:'#3b82f6',tempo:'#f59e0b',threshold:'#dc2626',vo2max:'#b91c1c',
  intervals:'#8b5cf6',recovery:'#22c55e',rest:'#a1a1aa',strength:'#f97316',race:'#ec4899',
};
const ACT_COLORS: Record<string, string> = {
  ride:'#3b82f6',run:'#22c55e',strength:'#f97316',swim:'#06b6d4',walk:'#a3e635',hike:'#84cc16',yoga:'#a78bfa',
};
const TYPE_LABELS: Record<string, string> = {
  endurance: 'Endurance', tempo: 'Tempo', threshold: 'Threshold', vo2max: 'VO2 Max',
  intervals: 'Intervals', recovery: 'Recovery', rest: 'Rest', race: 'Race',
  ride: 'Ride', run: 'Run', strength: 'Strength', swim: 'Swim', walk: 'Walk', hike: 'Hike', yoga: 'Yoga',
};

type DayData = LibDayData<Session, Activity>;


function formatDateLabel(dateStr: string) {
  const date = new Date(dateStr + 'T12:00:00');
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const diff = Math.round((date.getTime() - now.getTime()) / 86400000);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
  const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (diff === 0) return `Today, ${monthDay}`;
  if (diff === 1) return `Tomorrow, ${monthDay}`;
  if (diff === -1) return `Yesterday, ${monthDay}`;
  return `${dayName}, ${monthDay}`;
}

function isToday(d: string) { return d === localDateKey(new Date()); }
function isPast(d: string) { return d < localDateKey(new Date()); }
function formatDuration(s: number) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; }
// One formatter. There were two only because the list and detail payloads
// disagreed about whether distanceM was a string or a number; api-types.ts now
// settles that.
function formatDistance(m: number | null) { if (!m) return null; const km = m / 1000; return km >= 1 ? `${km.toFixed(1)} km` : `${m.toFixed(0)} m`; }
function formatTime(iso: string) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }

// Wahoo/Garmin often set the workout "name" to a generic label that just
// restates the sport (e.g. "Cycling") — redundant next to the type icon.
// Fall back to the start time instead, which actually differentiates cards.
const GENERIC_ACTIVITY_NAMES = new Set(['cycling', 'ciclismo', 'running', 'indoor cycling', 'ride', 'run']);
function hasCustomName(a: Activity): boolean {
  const name = a.name?.trim();
  return !!name && !GENERIC_ACTIVITY_NAMES.has(name.toLowerCase());
}
// For list rows with no other time indicator nearby.
function activityLabel(a: Activity): string {
  return hasCustomName(a) ? a.name!.trim() : formatTime(a.startedAt);
}
// For the detail sheet, where the time already appears in the subtitle.
function activityTitle(a: Activity): string {
  if (hasCustomName(a)) return a.name!.trim();
  return a.type.charAt(0).toUpperCase() + a.type.slice(1);
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function DetailSheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center animate-fade-in" onClick={onClose}>
      <div
        className="bg-card rounded-t-2xl md:rounded-2xl w-full max-w-[500px] max-h-[85vh] flex flex-col animate-sheet-up md:mb-6 shadow-[0_-4px_30px_rgba(0,0,0,0.12)]"
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function StatBlock({ val, label }: { val: string; label: string }) {
  return (
    <div className="bg-background rounded-xl p-3 flex flex-col items-center gap-1">
      <span className="text-base font-semibold">{val}</span>
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider text-center">{label}</span>
    </div>
  );
}

function ActivityDetail({ activity, onClose }: { activity: Activity; onClose: () => void }) {
  const [full, setFull] = useState<ActivityFull | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // .catch alongside .then: this fetch only enriches a card that already
    // renders from the summary row, so a failure just stops the spinner.
    // Without it a rejection leaves the spinner turning under the stats,
    // reading as "still loading" rather than "that's all", and goes out as an
    // unhandled rejection.
    getJson<ActivityFull>(`/api/activities/${activity.id}`)
      .then((data) => {
        if (!cancelled) setFull(data);
      })
      .catch(() => {
        // Nothing to show beyond the summary the card already has.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [activity.id]);

  const dist = formatDistance(full ? full.distanceM : activity.distanceM);
  const stats = full
    ? ([
        { val: formatDuration(full.durationS), label: 'Duration' },
        dist ? { val: dist, label: 'Distance' } : null,
        full.avgPower != null ? { val: `${full.avgPower}W`, label: 'Avg Power' } : null,
        full.normPower != null ? { val: `${full.normPower}W`, label: 'NP' } : null,
        full.maxPower != null ? { val: `${full.maxPower}W`, label: 'Max Power' } : null,
        full.intensityFactor != null ? { val: full.intensityFactor.toFixed(2), label: 'IF' } : null,
        full.avgHr != null ? { val: `${full.avgHr}`, label: 'Avg HR' } : null,
        full.maxHr != null ? { val: `${full.maxHr}`, label: 'Max HR' } : null,
        full.avgCadence != null ? { val: `${full.avgCadence}`, label: 'Cadence' } : null,
        full.elevationM != null ? { val: `${Math.round(full.elevationM)}m`, label: 'Elevation' } : null,
        full.tss != null ? { val: full.tss.toFixed(0), label: 'TSS' } : null,
        full.calories != null ? { val: `${full.calories}`, label: 'Calories' } : null,
      ].filter(Boolean) as { val: string; label: string }[])
    : [
        { val: formatDuration(activity.durationS), label: 'Duration' },
        dist ? { val: dist, label: 'Distance' } : null,
        activity.avgPower != null ? { val: `${activity.avgPower}W`, label: 'Avg Power' } : null,
        activity.normPower != null ? { val: `${activity.normPower}W`, label: 'NP' } : null,
        activity.tss != null ? { val: activity.tss.toFixed(0), label: 'TSS' } : null,
        activity.calories != null ? { val: String(activity.calories), label: 'Calories' } : null,
      ].filter(Boolean) as { val: string; label: string }[];

  const laps = (full?.laps ?? []).filter(l => l.durationS > 0);
  const showLaps = laps.length > 1;

  return (
    <DetailSheet onClose={onClose}>
      <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-border">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: (ACT_COLORS[activity.type] ?? '#a1a1aa') + '25', color: ACT_COLORS[activity.type] ?? '#a1a1aa' }}>
          <ActivityIcon type={activity.type} className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold truncate">{activityTitle(activity)}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {new Date(activity.startedAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · {formatTime(activity.startedAt)}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close" className="shrink-0 h-8 w-8" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>
      <div className="p-5 overflow-y-auto">
        <div className="grid grid-cols-3 gap-2">
          {stats.map(s => <StatBlock key={s.label} val={s.val} label={s.label} />)}
        </div>

        {loading && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {showLaps && (
          <div className="mt-5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Laps</p>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-secondary/60 text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">#</th>
                    <th className="text-right font-medium px-3 py-2">Time</th>
                    <th className="text-right font-medium px-3 py-2">Dist</th>
                    <th className="text-right font-medium px-3 py-2">Avg W</th>
                    <th className="text-right font-medium px-3 py-2">NP</th>
                    <th className="text-right font-medium px-3 py-2">HR</th>
                    <th className="text-right font-medium px-3 py-2">Cad</th>
                  </tr>
                </thead>
                <tbody>
                  {laps.map(lap => (
                    <tr key={lap.id} className="border-t border-border">
                      <td className="px-3 py-2">{lap.lapIndex + 1}</td>
                      <td className="text-right px-3 py-2">{formatDuration(lap.durationS)}</td>
                      <td className="text-right px-3 py-2">{formatDistance(lap.distanceM) ?? '—'}</td>
                      <td className="text-right px-3 py-2">{lap.avgPower ?? '—'}</td>
                      <td className="text-right px-3 py-2">{lap.normPower ?? '—'}</td>
                      <td className="text-right px-3 py-2">{lap.avgHr ?? '—'}</td>
                      <td className="text-right px-3 py-2">{lap.avgCadence ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </DetailSheet>
  );
}

function SessionDetail({ session, onClose }: { session: Session; onClose: () => void }) {
  const past = isPast(session.scheduledDate);
  const stats = [
    session.targetDurationMin != null ? { val: `${session.targetDurationMin}min`, label: 'Duration' } : null,
    session.targetTss != null ? { val: String(session.targetTss), label: 'TSS Target' } : null,
    session.targetIf != null ? { val: session.targetIf.toFixed(2), label: 'Intensity' } : null,
    session.feedbackRpe != null ? { val: `${session.feedbackRpe}/10`, label: 'RPE' } : null,
  ].filter(Boolean) as { val: string; label: string }[];

  return (
    <DetailSheet onClose={onClose}>
      <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-border">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: (SESSION_COLORS[session.sessionType] ?? '#a1a1aa') + '25', color: SESSION_COLORS[session.sessionType] ?? '#a1a1aa' }}>
          <SessionIcon type={session.sessionType} className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold truncate">{session.title}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {new Date(session.scheduledDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            {' · '}{session.completed ? 'Completed' : past ? 'Missed' : 'Scheduled'}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close" className="shrink-0 h-8 w-8" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>
      <div className="p-5 overflow-y-auto">
        {session.description && <p className="text-sm text-muted-foreground leading-relaxed mb-4 whitespace-pre-wrap">{session.description}</p>}
        {stats.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {stats.map(s => <StatBlock key={s.label} val={s.val} label={s.label} />)}
          </div>
        )}
      </div>
    </DetailSheet>
  );
}

type DetailTarget = { type: 'activity'; data: Activity } | { type: 'session'; data: Session } | null;

async function fetchRange(from: string, to: string): Promise<{ sessions: Session[]; activities: Activity[] }> {
  const [sessionsRes, activitiesRes] = await Promise.all([
    getJson<{ sessions: Session[] }>(`/api/athlete/sessions?from=${from}&to=${to}`),
    getJson<{ activities: Activity[] }>(`/api/activities?from=${from}&to=${to}&limit=200`),
  ]);
  return {
    sessions: sessionsRes.sessions ?? [],
    activities: activitiesRes.activities ?? [],
  };
}

export function CalendarTab() {
  const [viewDate, setViewDate] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => localDateKey(new Date()));
  const [dayMap, setDayMap] = useState<Map<string, DayData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<DetailTarget>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadMonth = useCallback(async (date: Date) => {
    setLoading(true);
    setLoadError(null);
    const grid = buildMonthGrid(date);
    const from = grid[0];
    const to = grid[grid.length - 1];

    // try/catch/finally around the fetch. Without it a rejected request skips
    // setLoading(false) along with setDayMap, and the calendar sits on its
    // spinner forever with no indication anything went wrong.
    try {
      const data = await fetchRange(from, to);
      setDayMap(mergeDays(data.sessions, data.activities));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load this month');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMonth(viewDate); }, [viewDate, loadMonth]);

  // DataSourceControls owns Wahoo connection state, the sync poll and the .fit
  // upload; this is the only thing the calendar needs from any of it.
  const reloadCurrentMonth = useCallback(() => loadMonth(viewDate), [loadMonth, viewDate]);

  // Memoised so legendEntries below can actually cache. Rebuilt inline, it hands
  // that memo a new array identity every render and the memo never hits.
  const grid = useMemo(() => buildMonthGrid(viewDate), [viewDate]);
  const monthLabel = viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const selectedDay = dayMap.get(selectedDate);
  const selectedHasAct = (selectedDay?.activities.length ?? 0) > 0;

  // Only the types actually visible this month — no point legending 16
  // possible colours when this month only ever used three of them.
  const legendEntries = useMemo(() => {
    // label -> colour directly, rather than packing both into a "label|colour"
    // string and splitting it back apart — which mangles any label containing a
    // pipe.
    const byLabel = new Map<string, string>();
    for (const dateStr of grid) {
      const day = dayMap.get(dateStr);
      day?.activities.forEach((a) =>
        byLabel.set(TYPE_LABELS[a.type] ?? a.type, ACT_COLORS[a.type] ?? '#a1a1aa'),
      );
      day?.sessions.forEach((s) =>
        byLabel.set(
          TYPE_LABELS[s.sessionType] ?? s.sessionType,
          SESSION_COLORS[s.sessionType] ?? '#a1a1aa',
        ),
      );
    }
    return [...byLabel].map(([label, color]) => ({ label, color }));
  }, [grid, dayMap]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
        <h1 className="font-display text-2xl font-bold tracking-tight">History</h1>
        <DataSourceControls onDataChanged={reloadCurrentMonth} />
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-8">
        {/* Month nav */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">{monthLabel}</h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost" size="icon" aria-label="Previous month" className="h-7 w-7"
              onClick={() => setViewDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost" size="sm" className="h-7 text-xs px-2"
              onClick={() => { const t = new Date(); setViewDate(t); setSelectedDate(localDateKey(new Date())); }}
            >
              Today
            </Button>
            <Button
              variant="ghost" size="icon" aria-label="Next month" className="h-7 w-7"
              onClick={() => setViewDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Weekday header */}
        <div className="grid grid-cols-7 mb-1">
          {WEEKDAY_LABELS.map((w, i) => (
            <div key={i} className="text-center text-[10px] font-medium text-muted-foreground uppercase tracking-wider py-1">{w}</div>
          ))}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <p className="text-sm text-muted-foreground">Could not load this month.</p>
            <p className="text-xs text-muted-foreground/70">{loadError}</p>
            <Button variant="outline" size="sm" onClick={reloadCurrentMonth}>Retry</Button>
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {grid.map(dateStr => {
              const inMonth = new Date(dateStr + 'T12:00:00').getMonth() === viewDate.getMonth();
              const day = dayMap.get(dateStr);
              const dots = [
                ...(day?.activities.map(a => ({ color: ACT_COLORS[a.type] ?? '#a1a1aa', label: TYPE_LABELS[a.type] ?? a.type })) ?? []),
                ...(day?.sessions.map(s => ({ color: SESSION_COLORS[s.sessionType] ?? '#a1a1aa', label: TYPE_LABELS[s.sessionType] ?? s.sessionType })) ?? []),
              ].slice(0, 4);
              const selected = dateStr === selectedDate;
              const today = isToday(dateStr);

              return (
                <button
                  key={dateStr}
                  type="button"
                  onClick={() => setSelectedDate(dateStr)}
                  className={cn(
                    'h-14 rounded-lg flex flex-col items-center justify-center gap-1 border transition-colors',
                    'border-transparent cursor-pointer',
                    !inMonth && 'opacity-30',
                    selected ? 'bg-secondary border-border' : 'hover:bg-secondary/50',
                    today && !selected && 'border-primary/50',
                  )}
                >
                  <span className={cn('text-xs', today ? 'text-primary font-bold' : 'font-medium')}>
                    {Number(dateStr.split('-')[2])}
                  </span>
                  <div className="flex gap-0.5">
                    {dots.map((d, i) => (
                      <span key={i} title={d.label} className="w-1.5 h-1.5 rounded-full" style={{ background: d.color }} />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Legend — only the types actually shown this month */}
        {legendEntries.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
            {legendEntries.map(e => (
              <div key={e.label} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: e.color }} />
                {e.label}
              </div>
            ))}
          </div>
        )}

        {/* Selected day panel */}
        <div className="mt-5">
          <p className="text-xs font-medium text-muted-foreground mb-2">{formatDateLabel(selectedDate)}</p>

          {!selectedDay || (selectedDay.activities.length === 0 && selectedDay.sessions.length === 0) ? (
            <p className="text-muted-foreground text-sm py-6 text-center">Nothing scheduled or logged this day.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {selectedHasAct && selectedDay.activities.map(a => {
                const dist = formatDistance(a.distanceM);
                return (
                  <Card
                    key={a.id}
                    className="py-0 cursor-pointer transition-colors hover:bg-secondary/50 active:scale-[0.99]"
                    onClick={() => setDetail({ type: 'activity', data: a })}
                  >
                    <CardContent className="py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: (ACT_COLORS[a.type] ?? '#a1a1aa') + '25', color: ACT_COLORS[a.type] ?? '#a1a1aa' }}>
                          <ActivityIcon type={a.type} className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-semibold truncate block">{activityLabel(a)}</span>
                          <div className="flex flex-wrap gap-2 mt-1 text-xs text-muted-foreground">
                            <span>{formatDuration(a.durationS)}</span>
                            {dist && <span>{dist}</span>}
                            {a.avgPower != null && <span>{a.avgPower}W</span>}
                            {a.tss != null && <span>{a.tss.toFixed(0)} TSS</span>}
                          </div>
                        </div>
                        <Badge variant="success" className="shrink-0">Done</Badge>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}

              {!selectedHasAct && selectedDay.sessions.map(s => {
                const past = isPast(s.scheduledDate);
                return (
                  <Card
                    key={s.id}
                    className={cn(
                      'py-0 cursor-pointer transition-colors hover:bg-secondary/50 active:scale-[0.99]',
                      !s.completed && past && 'opacity-50',
                    )}
                    onClick={() => setDetail({ type: 'session', data: s })}
                  >
                    <CardContent className="py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: (SESSION_COLORS[s.sessionType] ?? '#a1a1aa') + '25', color: SESSION_COLORS[s.sessionType] ?? '#a1a1aa' }}>
                          <SessionIcon type={s.sessionType} className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-semibold truncate block">{s.title}</span>
                          <div className="flex flex-wrap gap-2 mt-1 text-xs text-muted-foreground">
                            {s.targetDurationMin != null && <span>{s.targetDurationMin}min</span>}
                            {s.targetTss != null && <span>{s.targetTss} TSS</span>}
                            {s.targetIf != null && <span>IF {s.targetIf.toFixed(2)}</span>}
                          </div>
                        </div>
                        {s.completed ? (
                          <Badge variant="success" className="shrink-0">Done</Badge>
                        ) : past ? (
                          <Badge variant="destructive" className="shrink-0">Missed</Badge>
                        ) : (
                          <Badge variant="secondary" className="shrink-0">Planned</Badge>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {detail?.type === 'activity' && <ActivityDetail activity={detail.data} onClose={() => setDetail(null)} />}
      {detail?.type === 'session' && <SessionDetail session={detail.data} onClose={() => setDetail(null)} />}
    </div>
  );
}
