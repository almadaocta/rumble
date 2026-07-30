import React from 'react';
import {
  Bike, Zap, Flame, Activity, Timer, Heart, Moon, Dumbbell, Flag,
  Footprints, Waves, PersonStanding, Mountain, type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { CardHeader, CardTitle } from '@/components/ui/card';

const SESSION_ICON_MAP: Record<string, LucideIcon> = {
  endurance: Bike,
  tempo: Zap,
  threshold: Flame,
  vo2max: Activity,
  intervals: Timer,
  recovery: Heart,
  rest: Moon,
  strength: Dumbbell,
  race: Flag,
};

const ACTIVITY_ICON_MAP: Record<string, LucideIcon> = {
  ride: Bike,
  run: Footprints,
  strength: Dumbbell,
  swim: Waves,
  walk: PersonStanding,
  hike: Mountain,
  yoga: Heart,
};

const DEFAULT_ICON: LucideIcon = Activity;

export function SessionIcon({ type, className }: { type: string; className?: string }) {
  const Icon = SESSION_ICON_MAP[type] ?? DEFAULT_ICON;
  return <Icon className={className} />;
}

export function ActivityIcon({ type, className }: { type: string; className?: string }) {
  const Icon = ACTIVITY_ICON_MAP[type] ?? DEFAULT_ICON;
  return <Icon className={className} />;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest px-5 mt-4 pt-3 mb-5">{children}</p>
  );
}

// Simple labeled progress bar — for values with a real, meaningful target
// (macro grams vs a daily goal), where a filled track reads more naturally
// than the intensity-segment style above.
export function BarStat({
  value, unit, label, color, pct, noData, target,
}: {
  value: string | number;
  unit?: string;
  label: string;
  /** Dot + fill color, distinct per item (e.g. one hue per macro). */
  color: string;
  /** 0-100, already scaled to whatever range makes sense for this metric. */
  pct: number;
  /** Not logged yet — show "—" and a neutral dot/track instead of 0 in the item's colour, so an empty value doesn't read as an error. */
  noData?: boolean;
  /** Daily goal this bar is tracking toward — shown as "/ {target}{unit}" next to the value. */
  target?: string | number;
}) {
  const dotColor = noData ? 'var(--color-border)' : color;
  return (
    <div>
      <div className="flex items-end justify-between mb-2">
        <div className="flex items-baseline gap-1">
          <span className="text-2xl font-semibold leading-none">{noData ? '—' : value}</span>
          {unit && !noData && <span className="text-xs text-muted-foreground">{unit}</span>}
          {target != null && (
            <span className="text-xs text-muted-foreground">/ {target}{unit}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {label}
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dotColor }} />
        </div>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        {!noData && (
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }}
          />
        )}
      </div>
    </div>
  );
}

// Single semantic intensity scale used everywhere a value needs to read as
// "how good/complete is this" — dark, muted orange (bad/low) to bright brand
// orange (good/high). One hue, one meaning, used consistently instead of
// switching palettes per card (see COLOR_SYSTEM.md).
const DARK_ORANGE_RGB: [number, number, number] = [110, 55, 28];
const BRIGHT_ORANGE_RGB: [number, number, number] = [255, 97, 22];
const SEGMENT_TICKS = 14;

function intensityColor(intensity: number, alpha = 1): string {
  const t = Math.max(0, Math.min(1, intensity));
  const [r, g, b] = DARK_ORANGE_RGB.map((c, i) => Math.round(c + (BRIGHT_ORANGE_RGB[i] - c) * t));
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface SegmentStatItem {
  value: string | number;
  unit?: string;
  label: string;
  tooltip?: string;
  /** 0-1 — how "good"/complete this value is. Drives the colour, dark orange (0) to bright orange (1). */
  intensity: number;
  /**
   * Hide the tick row. Use for values with no real bounded/reference scale
   * (e.g. CTL/ATL/Ramp Rate) — ticks there would imply a 0-100%-style range
   * these metrics don't have. Default true (ticks shown) for values that
   * genuinely are a percentage of a target (macros, calorie budget).
   */
  showTicks?: boolean;
  /**
   * Not logged / no data yet. Renders "—" and a neutral border colour instead
   * of computing from intensity, so an empty value reads as "nothing logged"
   * rather than "scored zero" (which would otherwise paint it as the worst
   * possible value).
   */
  noData?: boolean;
}

// Shared "vertical segment" stat row — each metric gets a full-height divider,
// a label, a number, and (optionally) a row of small ticks beneath it, tinted
// by how good/complete that metric's value is. Used anywhere a card shows a
// small set (2-4) of related numbers side by side (Nutrition calories/macros,
// Current State).
export function SegmentedStats({ items }: { items: SegmentStatItem[] }) {
  return (
    <div className="flex">
      {items.map(it => {
        const showTicks = it.showTicks ?? true;
        const color = it.noData ? 'var(--color-border)' : intensityColor(it.intensity);
        return (
          <div key={it.label} className="flex-1 min-w-0 pl-4 border-l" style={{ borderColor: color }}>
            {it.tooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="text-xs text-muted-foreground truncate underline decoration-dotted underline-offset-2 cursor-help w-fit">
                    {it.label}
                  </p>
                </TooltipTrigger>
                <TooltipContent>{it.tooltip}</TooltipContent>
              </Tooltip>
            ) : (
              <p className="text-xs text-muted-foreground truncate">{it.label}</p>
            )}
            <p className="text-2xl font-semibold leading-none mt-1.5">
              {it.noData ? '—' : it.value}
              {it.unit && !it.noData && <span className="text-xs font-medium text-muted-foreground ml-1">{it.unit}</span>}
            </p>
            {showTicks && (
              <div className="flex gap-[3px] mt-3 h-4">
                {Array.from({ length: SEGMENT_TICKS }, (_, j) => (
                  <div key={j} className="w-[2px] h-full rounded-full" style={{ background: color }} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const HERO_GRADIENT = 'linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 70%, #242424 100%)';
export const HERO_SHADOW = '0 4px 20px rgba(0,0,0,0.15)';

// Small circular icon badge that sits next to a CardTitle — matches the
// reference dashboards' card-header pattern (icon chip + title, not just text).
// The one shape every card header must use: icon badge + title, same gap and
// sizing everywhere — never hand-roll this markup at a call site.
export function CardIconHeader({
  icon, label, color, iconColor, titleClassName,
}: {
  icon: LucideIcon;
  label: string;
  color?: string;
  iconColor?: string;
  titleClassName?: string;
}) {
  return (
    <CardHeader className="flex-row items-center gap-2.5">
      <IconBadge icon={icon} color={color} iconColor={iconColor} />
      <CardTitle className={titleClassName}>{label}</CardTitle>
    </CardHeader>
  );
}

export function IconBadge({
  icon: Icon, color = 'var(--color-muted)', iconColor = 'var(--color-foreground)',
}: {
  icon: LucideIcon;
  /** Circle background — give each icon its own specific colour rather than a generic grey chip. */
  color?: string;
  iconColor?: string;
}) {
  return (
    <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: color }}>
      <Icon className="w-3.5 h-3.5" style={{ color: iconColor }} />
    </div>
  );
}

// Deterministic pseudo-random (stable across renders, no jitter/flicker on
// re-render) — a cheap sine-hash rather than Math.random().
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 43758.5453;
  return x - Math.floor(x);
}

const SPOKE_COUNT = 36;
const SPOKE_OUTER_R = 78;

// Perfectly evenly spaced angles — no jitter — so lines can never cross by
// construction. Same length/dot-size for every spoke; these never change.
// Only how many dots each spoke shows reacts to the metric's value (see
// dotCountsForIntensity below), so the shape itself responds to the data.
const SPOKES = Array.from({ length: SPOKE_COUNT }, (_, i) => {
  const r1 = seededRandom(i * 12.9898);
  return {
    angle: (i / SPOKE_COUNT) * 360,
    outerR: SPOKE_OUTER_R,
    dotR: 1.5 + r1 * 1,
  };
});

// Dot count per spoke: 0-3, deterministic for a given intensity, never equal
// to the previous (contiguous) spoke's count — including the wrap-around,
// since this is a circle, not a line. Higher intensity biases toward denser
// (fuller) spokes — a fresher/better value visibly fills the ring out more.
function dotCountsForIntensity(intensity: number): number[] {
  const spread = 0.35 + Math.max(0, Math.min(1, intensity)) * 0.65;
  const counts: number[] = [];
  for (let i = 0; i < SPOKE_COUNT; i++) {
    const r = seededRandom(i * 51.734 + 7);
    let count = Math.min(3, Math.floor(r * 4 * spread));
    if (count === counts[i - 1]) count = (count + 1) % 4;
    counts.push(count);
  }
  if (counts[SPOKE_COUNT - 1] === counts[0]) {
    counts[SPOKE_COUNT - 1] = (counts[SPOKE_COUNT - 1] + 1) % 4;
  }
  return counts;
}

// Single-metric "spotlight" stat: a sunburst of evenly-spaced spokes
// radiating from the center, slowly rotating, each with a few small dots
// trailing toward the tip — for the one metric that answers "how am I
// doing" at a glance, not a comparative/trend card. Dot density and colour
// both track `intensity` (0-1) on a single orange hue — dark/muted orange
// for a bad value, bright brand orange for a good one (never green, to stay
// on-brand for this particular card).
export function SunburstStat({ value, sublabel, intensity = 1 }: { value: string | number; sublabel: string; intensity?: number }) {
  const innerR = 52;
  const dotColor = intensityColor(intensity);
  const lineColor = intensityColor(intensity, 0.35);
  const dotCounts = React.useMemo(() => dotCountsForIntensity(intensity), [intensity]);
  return (
    <div className="relative w-full aspect-square flex items-center justify-center">
      <svg viewBox="0 0 200 200" className="absolute inset-0 w-full h-full">
        <g style={{ transformOrigin: '100px 100px', animation: 'spin 90s linear infinite' }}>
          {SPOKES.map((s, i) => {
            const rad = (s.angle * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const midR = (innerR + s.outerR) / 2;
            const x1 = 100 + innerR * cos, y1 = 100 + innerR * sin;
            const x2 = 100 + s.outerR * cos, y2 = 100 + s.outerR * sin;
            const xm = 100 + midR * cos, ym = 100 + midR * sin;
            const dotPositions = [[x2, y2], [xm, ym], [x1, y1]].slice(0, dotCounts[i]);
            return (
              <g key={i}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={lineColor} strokeWidth="1" />
                {dotPositions.map(([dx, dy], j) => (
                  <circle key={j} cx={dx} cy={dy} r={s.dotR} fill={dotColor} />
                ))}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="relative z-10 text-center">
        <div className="text-5xl font-semibold tracking-tight">{value}</div>
        <p className="text-sm text-muted-foreground mt-1">{sublabel}</p>
      </div>
    </div>
  );
}
