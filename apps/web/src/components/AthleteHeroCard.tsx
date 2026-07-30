import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronDown } from 'lucide-react';
import { HERO_GRADIENT, HERO_SHADOW } from '@/components/shared';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { AthleteProfile } from '@/lib/api-types';

const POWER_LABELS_ORDER = ['1s','3s','10s','30s','1min','5min','10min','15min','20min','30min','1hr','2hr'];

interface MetricValue { val: string; unit: string; label: string; }

function MetricTile({ val, unit, label }: MetricValue) {
  return (
    <div>
      <p className="text-xl font-semibold leading-none whitespace-nowrap">{val}<span className="text-sm font-medium text-[#f3f3f3]/60 ml-0.5">{unit}</span></p>
      {label && <p className="text-[10px] text-[#f3f3f3]/40 mt-1">{label}</p>}
    </div>
  );
}

const CHART_W = 320;
const CHART_H = 170;
const PAD = { top: 12, bottom: 26, left: 8, right: 8 };

function PowerChart({ powerBests }: { powerBests: Record<string, number | null> }) {
  const entries = POWER_LABELS_ORDER.map(l => ({ label: l, watts: powerBests[l] }))
    .filter((e): e is { label: string; watts: number } => e.watts != null);
  if (entries.length < 2) return null;

  const maxW = Math.max(...entries.map(e => e.watts));
  const minW = Math.min(...entries.map(e => e.watts));
  const range = maxW - minW || 1;
  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;

  const points = entries.map((e, i) => ({
    ...e,
    x: PAD.left + (entries.length === 1 ? plotW / 2 : (i / (entries.length - 1)) * plotW),
    y: PAD.top + (1 - (e.watts - minW) / range) * plotH,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  return (
    <div className="relative w-full" style={{ paddingBottom: `${(CHART_H / CHART_W) * 100}%` }}>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="absolute inset-0 w-full h-full">
        {[0, 0.5, 1].map(t => {
          const y = PAD.top + t * plotH;
          return <line key={t} x1={PAD.left} y1={y} x2={CHART_W - PAD.right} y2={y} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />;
        })}
        <path d={linePath} fill="none" stroke="var(--color-orange)" strokeWidth="1" strokeLinejoin="round" strokeLinecap="round" />
        {points.map(p => (
          <circle key={p.label} cx={p.x} cy={p.y} r="3" fill="var(--color-orange)" stroke="#1a1a1a" strokeWidth="1.5" />
        ))}
        {points.map(p => (
          <text key={p.label} x={p.x} y={CHART_H - 6} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize="8">{p.label}</text>
        ))}
      </svg>

      {/* Invisible hit-areas + tooltips, positioned to match the SVG points exactly (same viewBox proportions). */}
      {points.map(p => (
        <Tooltip key={p.label}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`${p.label}: ${p.watts} watts`}
              className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent border-none cursor-pointer"
              style={{ left: `${(p.x / CHART_W) * 100}%`, top: `${(p.y / CHART_H) * 100}%` }}
            />
          </TooltipTrigger>
          <TooltipContent>{p.label}: {p.watts}W</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

export function AthleteHeroCard({ profile, maxHr, powerBests, thisWeek }: {
  profile: AthleteProfile;
  maxHr: number | null;
  powerBests: Record<string, number | null>;
  thisWeek?: { tss: number; hours: number; rides: number };
}) {
  const [showPower, setShowPower] = useState(false);

  const hasPower = powerBests && Object.values(powerBests).some(v => v != null);
  const p = profile;

  const profileMetrics: MetricValue[] = [
    p.age != null && { val: `${p.age}`, unit: 'years', label: '' },
    p.ftp != null && { val: `${p.ftp}`, unit: 'W FTP', label: '' },
    p.wkg && { val: p.wkg, unit: 'W/kg', label: '' },
    p.weightKg != null && { val: `${p.weightKg}`, unit: 'kg', label: '' },
    maxHr != null && { val: `${maxHr}`, unit: 'bpm max', label: '' },
  ].filter(Boolean) as MetricValue[];

  const weekMetrics: MetricValue[] = thisWeek ? [
    { val: `${thisWeek.tss}`, unit: 'TSS', label: '' },
    { val: `${thisWeek.hours}`, unit: 'Hours', label: '' },
    { val: `${thisWeek.rides}`, unit: 'Rides', label: '' },
  ] : [];

  return (
    <Card className="text-[#f3f3f3]" style={{ background: HERO_GRADIENT, boxShadow: HERO_SHADOW }}>
      <CardContent>
        <h1 className="font-display text-2xl font-extrabold tracking-tight">{p.name}</h1>
        {(profileMetrics.length > 0 || weekMetrics.length > 0) && (
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3 mt-4 pt-4 border-t border-white/15">
            {profileMetrics.map(m => <MetricTile key={m.unit} {...m} />)}
            {weekMetrics.length > 0 && (
              <div className="self-stretch flex items-center pl-6 border-l border-white/15">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#f3f3f3]/40">This Week</span>
              </div>
            )}
            {weekMetrics.map(m => <MetricTile key={m.unit} {...m} />)}
          </div>
        )}

        {hasPower && (
          <div className="mt-4 pt-4 border-t border-white/15">
            <button
              type="button"
              onClick={() => setShowPower(v => !v)}
              className="flex items-center justify-between w-full bg-transparent border-none cursor-pointer p-0"
            >
              <span className="text-xs font-medium text-[#f3f3f3]/70">Power breakdown</span>
              <ChevronDown className={cn('w-4 h-4 text-[#f3f3f3]/70 transition-transform', showPower && 'rotate-180')} />
            </button>

            {showPower && (
              <div className="mt-4">
                <PowerChart powerBests={powerBests} />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
