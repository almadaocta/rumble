import { Bike, Salad, Moon, Dumbbell, type LucideIcon } from 'lucide-react';

/** Mirrors apps/bff/src/modules/claude/model-config.ts — no shared package, see api-types.ts. */
export type Specialist = 'cycling_coach' | 'nutritionist' | 'strength_conditioning' | 'recovery';

interface SpecialistMeta {
  label: string;
  /** Single letter for the avatar circle — distinct across all four, matches the orchestrator's own initial-avatar treatment. */
  initial: string;
  icon: LucideIcon;
  color: string;
  colorForeground: string;
}

/** Icon + label + color badge per specialist, for rendering their consult replies as their own voice. */
export const SPECIALIST_META: Record<Specialist, SpecialistMeta> = {
  cycling_coach: {
    label: 'Cycling Coach',
    initial: 'C',
    icon: Bike,
    color: 'var(--color-orange)',
    colorForeground: 'var(--color-orange-foreground)',
  },
  nutritionist: {
    label: 'Nutritionist',
    initial: 'N',
    icon: Salad,
    color: 'var(--color-lime)',
    colorForeground: 'var(--color-lime-foreground)',
  },
  recovery: {
    label: 'Recovery Specialist',
    initial: 'R',
    icon: Moon,
    color: 'var(--color-sky)',
    colorForeground: 'var(--color-sky-foreground)',
  },
  strength_conditioning: {
    label: 'Strength & Conditioning',
    initial: 'S',
    icon: Dumbbell,
    color: 'var(--color-violet)',
    colorForeground: 'var(--color-violet-foreground)',
  },
};

export function isSpecialist(value: unknown): value is Specialist {
  return typeof value === 'string' && value in SPECIALIST_META;
}
