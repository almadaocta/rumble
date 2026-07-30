import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Flame, ChevronDown } from 'lucide-react';
import { BarStat, SegmentedStats, CardIconHeader } from '@/components/shared';
import { cn } from '@/lib/utils';
import { getJson } from '@/lib/api';
import type { Meal, NutritionToday } from '@/lib/api-types';

// Daily targets aren't stored per-athlete anywhere yet (no macro-goal fields
// on the athletes table) — fixed defaults until that exists.
const CALORIE_TARGET = 2800;
// Categorical, like the calendar's activity-type colors (see COLOR_SYSTEM.md)
// — three macros just need to be visually distinct from each other, not
// mapped to brand/intensity/secondary meaning. Protein deliberately isn't
// black: black is the app's neutral/structural color, not a data category.
const MACRO_TARGETS = {
  carbs: { label: 'Carbs', target: 350, unit: 'g', color: 'var(--color-orange)' },
  protein: { label: 'Protein', target: 140, unit: 'g', color: '#92400e' },
  fat: { label: 'Fat', target: 80, unit: 'g', color: 'var(--color-lime)' },
} as const;

function mealMacros(m: Meal): string {
  const parts = [
    m.calories != null && `${m.calories} kcal`,
    m.carbsG != null && `${m.carbsG}c`,
    m.proteinG != null && `${m.proteinG}p`,
    m.fatG != null && `${m.fatG}f`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No macros logged';
}

export function NutritionTab() {
  const [today, setToday] = useState<NutritionToday | null>(null);
  const [showMeals, setShowMeals] = useState(false);

  const fetchToday = useCallback(async () => {
    // Polls every 60s; a failed poll keeps the last good day rather than
    // blanking the macros back to zero.
    const data = await getJson<NutritionToday>('/api/nutrition/today').catch(() => null);
    if (data) setToday(data);
  }, []);

  useEffect(() => { fetchToday(); const t = setInterval(fetchToday, 60000); return () => clearInterval(t); }, [fetchToday]);

  const noneLogged = !today?.logged;
  const consumed = today?.calories ?? 0;
  const remaining = Math.max(0, CALORIE_TARGET - consumed);
  const meals = today?.meals ?? [];

  const macros = [
    { ...MACRO_TARGETS.carbs, current: today?.carbsG ?? null },
    { ...MACRO_TARGETS.protein, current: today?.proteinG ?? null },
    { ...MACRO_TARGETS.fat, current: today?.fatG ?? null },
  ];

  return (
    <div className="p-5">
      <Card>
        <CardIconHeader icon={Flame} label="Nutrition" color="var(--color-primary)" iconColor="var(--color-primary-foreground)" />
        <CardContent>
          <SegmentedStats
            items={[
              { value: consumed, unit: 'kcal', label: 'Consumed', intensity: consumed / CALORIE_TARGET, noData: noneLogged },
              { value: CALORIE_TARGET, unit: 'kcal', label: 'Target', intensity: 1 },
              { value: remaining, unit: 'kcal', label: 'Left', intensity: remaining / CALORIE_TARGET, noData: noneLogged },
            ]}
          />

          <div className="flex flex-col gap-4 mt-6 pt-5 border-t border-border">
            {macros.map(m => (
              <BarStat
                key={m.label}
                value={m.current ?? 0}
                unit={m.unit}
                target={m.target}
                label={m.label}
                color={m.color}
                pct={m.current != null ? (m.current / m.target) * 100 : 0}
                noData={m.current == null}
              />
            ))}
          </div>

          {meals.length > 0 ? (
            <div className="mt-5 pt-4 border-t border-border">
              <button
                type="button"
                onClick={() => setShowMeals(v => !v)}
                className="flex items-center justify-between w-full bg-transparent border-none cursor-pointer p-0"
              >
                <span className="text-xs font-medium text-muted-foreground">
                  Today's meals ({meals.length})
                </span>
                <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform', showMeals && 'rotate-180')} />
              </button>

              {showMeals && (
                <div className="mt-3 flex flex-col">
                  {meals.map(m => (
                    <div key={m.id} className="py-2.5 border-t border-border first:border-0">
                      <p className="text-sm font-medium">{m.description}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {m.mealType && <span className="capitalize">{m.mealType} · </span>}
                        {mealMacros(m)}
                        {m.estimated && ' · estimated'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center mt-4">Log your meals via chat to track macros</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
