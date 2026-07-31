import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Flag, TrendingUp, CalendarDays, Zap } from 'lucide-react';
import { SunburstStat, CardIconHeader, SegmentedStats, type SegmentStatItem } from '@/components/shared';
import { AthleteHeroCard } from '@/components/AthleteHeroCard';
import { tsbLabel, tsbIntensity } from '@/lib/training';
import { getJson } from '@/lib/api';

import type { AthleteStats as Stats, PlanSession as Session } from '@/lib/api-types';

export function TodayTab({ onViewCalendar, onProfileName }: { onViewCalendar: () => void; onProfileName?: (name: string) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [nextTraining, setNextTraining] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    // Per-request `.catch(() => null)` rather than one around the Promise.all:
    // the two halves of this screen are independent, and a failed sessions read
    // shouldn't blank out stats that arrived fine. This also runs on a 2-minute
    // interval, so a failure keeps whatever was last shown.
    const [stats, sessionsRes] = await Promise.all([
      getJson<Stats>('/api/athlete/stats').catch(() => null),
      getJson<{ sessions: Session[] }>('/api/athlete/sessions?weeks=3&past=0').catch(() => null),
    ]);

    if (stats) {
      setStats(stats);
      if (stats.profile?.name) onProfileName?.(stats.profile.name);
    }
    if (sessionsRes) {
      setNextTraining(sessionsRes.sessions?.find((s) => !s.completed) ?? null);
    }
    setLoading(false);
  }, [onProfileName]);

  useEffect(() => { fetchData(); const t = setInterval(fetchData, 120000); return () => clearInterval(t); }, [fetchData]);

  if (loading) return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>;
  if (!stats) return <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-6 text-center">No data yet. Connect your tracker and sync activities.</div>;

  return (
    <div className="p-5">
      <div className="grid grid-cols-1 gap-2">
        <AthleteHeroCard profile={stats.profile} maxHr={stats.maxHr} powerBests={stats.powerBests} thisWeek={stats.thisWeek} onProfileName={onProfileName} />

        <div className="flex flex-col sm:flex-row gap-2 items-stretch">
          {/* Left: Training Stress Balance — the single most useful "how am I doing" signal, so it gets the spotlight column */}
          {stats.fitness?.tsb != null && (
            <Card className="sm:flex-1 sm:basis-0 flex flex-col">
              <CardIconHeader icon={Zap} label="Training Stress Balance" color="var(--color-orange)" iconColor="var(--color-orange-foreground)" />
              <CardContent className="flex-1 flex items-center justify-center min-h-0">
                <SunburstStat
                  value={Math.round(stats.fitness.tsb) > 0 ? `+${Math.round(stats.fitness.tsb)}` : Math.round(stats.fitness.tsb)}
                  sublabel={tsbLabel(stats.fitness.tsb)}
                  intensity={tsbIntensity(stats.fitness.tsb)}
                />
              </CardContent>
            </Card>
          )}

          {/* Right: Next Training / Next Event / Current State, stacked */}
          <div className="sm:flex-1 sm:basis-0 flex flex-col gap-2">
            <Card className="flex-1 cursor-pointer text-[#f3f3f3]" style={{ background: '#d9530f' }} onClick={onViewCalendar}>
              <CardIconHeader
                icon={CalendarDays} label="Next Training"
                color="rgba(255,255,255,0.2)" iconColor="#f3f3f3"
                titleClassName="text-[#f3f3f3]"
              />
              <CardContent className="flex-1 flex items-center gap-3 min-h-0">
                {nextTraining ? (
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{nextTraining.title}</p>
                    <p className="text-xs text-[#f3f3f3]/70 mt-0.5">
                      {new Date(nextTraining.scheduledDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                      {nextTraining.targetDurationMin != null && ` · ${nextTraining.targetDurationMin}min`}
                      {nextTraining.targetTss != null && ` · ${nextTraining.targetTss} TSS`}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-[#f3f3f3]/80">Nothing scheduled yet.</p>
                )}
              </CardContent>
            </Card>

            {stats.nextEvent && (
              <Card className="flex-1" style={{ background: 'var(--color-lime)', color: 'var(--color-lime-foreground)' }}>
                <CardIconHeader
                  icon={Flag} label="Next Event"
                  color="rgba(0,0,0,0.1)" iconColor="var(--color-lime-foreground)"
                  titleClassName="text-[var(--color-lime-foreground)]"
                />
                <CardContent className="flex-1 flex items-center gap-3 min-h-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{stats.nextEvent.name}</p>
                    <p className="text-xs text-[var(--color-lime-foreground)]/70 mt-0.5">
                      {new Date(stats.nextEvent.eventDate+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {stats.fitness && (
              <Card className="flex-1">
                <CardIconHeader icon={TrendingUp} label="Current State" color="rgba(24,24,27,0.55)" iconColor="#ffffff" />
                <CardContent className="flex-1 flex flex-col justify-center min-h-0">
                  {/* No tick row here — CTL/ATL/Ramp have no fixed 0-100 range, so a bar
                      would falsely imply one. Number + colour only. */}
                  <SegmentedStats
                    items={[
                      stats.fitness.ctl != null && {
                        value: Math.round(stats.fitness.ctl), label: 'CTL',
                        tooltip: 'Chronic Training Load — long-term fitness',
                        intensity: Math.max(0, Math.min(1, stats.fitness.ctl / 100)),
                        showTicks: false,
                      },
                      stats.fitness.atl != null && {
                        value: Math.round(stats.fitness.atl), label: 'ATL',
                        tooltip: 'Acute Training Load — recent fatigue',
                        intensity: Math.max(0, Math.min(1, stats.fitness.atl / 100)),
                        showTicks: false,
                      },
                      stats.fitness.rampRate != null && {
                        value: stats.fitness.rampRate.toFixed(1), label: 'Ramp',
                        tooltip: 'Ramp Rate — weekly load trend',
                        intensity: Math.max(0, Math.min(1, Math.abs(stats.fitness.rampRate) / 10)),
                        showTicks: false,
                      },
                    ].filter(Boolean) as SegmentStatItem[]}
                  />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
