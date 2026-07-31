# Profile Edit UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pencil-icon-triggered sheet modal that lets the athlete edit their name, weight, height, age, FTP, sex, available hours/week, experience level, and timezone.

**Architecture:** New `PATCH /api/athlete/profile` backend route with Zod validation → new `ProfileEditSheet` frontend component using the existing `DetailSheet` pattern → `AthleteHeroCard` gets a local profile state copy and a pencil icon to open the sheet.

**Tech Stack:** Express + Drizzle ORM + Zod (backend); React + Tailwind CSS v4 (frontend); existing lucide-react icons; vitest + supertest (backend tests).

---

## File Map

| Action | File |
|---|---|
| Modify | `apps/bff/src/modules/athlete/athlete.controller.ts` |
| Modify | `apps/bff/src/modules/athlete/athlete.controller.test.ts` |
| Modify | `apps/web/src/lib/api-types.ts` |
| Create | `apps/web/src/components/ProfileEditSheet.tsx` |
| Modify | `apps/web/src/components/AthleteHeroCard.tsx` |

---

## Task 1: PATCH /api/athlete/profile — backend route + tests

**Files:**
- Modify: `apps/bff/src/modules/athlete/athlete.controller.ts`
- Modify: `apps/bff/src/modules/athlete/athlete.controller.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `apps/bff/src/modules/athlete/athlete.controller.test.ts`, after the existing `describe` blocks:

```ts
describe('PATCH /api/athlete/profile', () => {
  it('updates name and returns updated profile', async () => {
    const res = await request(app)
      .patch('/api/athlete/profile')
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
  });

  it('updates numeric fields correctly', async () => {
    const res = await request(app)
      .patch('/api/athlete/profile')
      .send({ ftp: 280, weightKg: 72.5, heightCm: 178, age: 34 });

    expect(res.status).toBe(200);
    expect(res.body.ftp).toBe(280);
    expect(res.body.weightKg).toBe(72.5);
    expect(res.body.heightCm).toBe(178);
    expect(res.body.age).toBe(34);
  });

  it('recalculates wkg when ftp and weight are both set', async () => {
    await request(app).patch('/api/athlete/profile').send({ ftp: 200, weightKg: 80 });
    const res = await request(app).patch('/api/athlete/profile').send({});
    expect(res.body.wkg).toBe('2.50');
  });

  it('returns wkg null when weight is missing', async () => {
    const res = await request(app)
      .patch('/api/athlete/profile')
      .send({ ftp: 250 });
    expect(res.body.wkg).toBeNull();
  });

  it('rejects empty name with 400', async () => {
    const res = await request(app)
      .patch('/api/athlete/profile')
      .send({ name: '' });
    expect(res.status).toBe(400);
  });

  it('rejects negative ftp with 400', async () => {
    const res = await request(app)
      .patch('/api/athlete/profile')
      .send({ ftp: -10 });
    expect(res.status).toBe(400);
  });

  it('rejects age out of range with 400', async () => {
    const res = await request(app)
      .patch('/api/athlete/profile')
      .send({ age: 200 });
    expect(res.status).toBe(400);
  });

  it('accepts partial update — unmentioned fields unchanged', async () => {
    await db.update(athletes).set({ ftp: 300 }).where(eq(athletes.id, athleteId));
    const res = await request(app)
      .patch('/api/athlete/profile')
      .send({ name: 'Partial' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Partial');
    expect(res.body.ftp).toBe(300);
  });

  it('404s when athlete row is missing', async () => {
    await db.delete(athletes).where(eq(athletes.id, athleteId));
    const res = await request(app)
      .patch('/api/athlete/profile')
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('returns sex, availableHoursWeek, timezone, heightCm in response', async () => {
    const res = await request(app)
      .patch('/api/athlete/profile')
      .send({ sex: 'male', availableHoursWeek: 10, timezone: 'America/New_York', heightCm: 180 });
    expect(res.status).toBe(200);
    expect(res.body.sex).toBe('male');
    expect(res.body.availableHoursWeek).toBe(10);
    expect(res.body.timezone).toBe('America/New_York');
    expect(res.body.heightCm).toBe(180);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/bff && pnpm test athlete.controller
```

Expected: all new tests FAIL with 404 (route not found).

- [ ] **Step 3: Add zod dependency check**

```bash
cd apps/bff && pnpm ls zod
```

If zod is not listed, install it:
```bash
cd apps/bff && pnpm add zod
```

- [ ] **Step 4: Implement the route**

In `apps/bff/src/modules/athlete/athlete.controller.ts`, add after the existing imports:

```ts
import { z } from 'zod';
```

Then add this route after the `GET /stats` route (after line 230, before the end of file):

```ts
const patchProfileSchema = z.object({
  name:               z.string().min(1).optional(),
  weightKg:           z.number().positive().optional(),
  heightCm:           z.number().int().positive().optional(),
  age:                z.number().int().min(1).max(120).optional(),
  ftp:                z.number().int().positive().optional(),
  sex:                z.string().optional(),
  availableHoursWeek: z.number().positive().optional(),
  experienceLevel:    z.string().optional(),
  timezone:           z.string().min(1).optional(),
}).strict();

athleteController.patch('/profile', asyncRoute(async (req: Request, res: Response) => {
  const athleteId = req.athleteId;

  const parsed = patchProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  }

  const updates = parsed.data;
  if (Object.keys(updates).length === 0) {
    // No-op update: still fetch and return current profile
  } else {
    await db.update(athletes).set(updates).where(eq(athletes.id, athleteId));
  }

  const [athlete] = await db
    .select({
      name:               athletes.name,
      ftp:                athletes.ftp,
      weightKg:           athletes.weightKg,
      heightCm:           athletes.heightCm,
      age:                athletes.age,
      sex:                athletes.sex,
      availableHoursWeek: athletes.availableHoursWeek,
      experienceLevel:    athletes.experienceLevel,
      timezone:           athletes.timezone,
    })
    .from(athletes)
    .where(eq(athletes.id, athleteId))
    .limit(1);

  if (!athlete) return res.status(404).json({ error: 'No athlete' });

  const wkg =
    athlete.ftp && athlete.weightKg
      ? (athlete.ftp / Number(athlete.weightKg)).toFixed(2)
      : null;

  res.json({
    name:               athlete.name,
    ftp:                athlete.ftp,
    weightKg:           athlete.weightKg ? Number(athlete.weightKg) : null,
    heightCm:           athlete.heightCm,
    age:                athlete.age,
    sex:                athlete.sex,
    availableHoursWeek: athlete.availableHoursWeek ? Number(athlete.availableHoursWeek) : null,
    experienceLevel:    athlete.experienceLevel,
    timezone:           athlete.timezone,
    wkg,
  });
}));
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd apps/bff && pnpm test athlete.controller
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bff/src/modules/athlete/athlete.controller.ts \
        apps/bff/src/modules/athlete/athlete.controller.test.ts
git commit -m "feat: add PATCH /api/athlete/profile endpoint"
```

---

## Task 2: Extend AthleteProfile type

**Files:**
- Modify: `apps/web/src/lib/api-types.ts:81-89`

- [ ] **Step 1: Update the AthleteProfile interface**

Replace lines 81–89 in `apps/web/src/lib/api-types.ts`:

```ts
export interface AthleteProfile {
  name: string;
  ftp: number | null;
  weightKg: number | null;
  /** Pre-formatted by the BFF to 2dp, hence a string. */
  wkg: string | null;
  age: number | null;
  heightCm: number | null;
  sex: string | null;
  availableHoursWeek: number | null;
  experienceLevel: string | null;
  timezone: string | null;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/web && pnpm tsc --noEmit
```

Expected: no errors (the new fields are all nullable so existing call sites are fine).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api-types.ts
git commit -m "feat: extend AthleteProfile type with heightCm, sex, availableHoursWeek, timezone"
```

---

## Task 3: ProfileEditSheet component

**Files:**
- Create: `apps/web/src/components/ProfileEditSheet.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/ProfileEditSheet.tsx` with this full content:

```tsx
import { useState } from 'react';
import type { AthleteProfile } from '@/lib/api-types';
import { patchJson } from '@/lib/api';

const EXPERIENCE_OPTIONS = ['beginner', 'intermediate', 'advanced', 'elite'];
const SEX_OPTIONS = ['male', 'female', 'other'];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 ' +
  'placeholder:text-muted-foreground';

export function ProfileEditSheet({
  profile,
  onClose,
  onSaved,
}: {
  profile: AthleteProfile;
  onClose: () => void;
  onSaved: (updated: AthleteProfile) => void;
}) {
  const [name, setName]                         = useState(profile.name ?? '');
  const [age, setAge]                           = useState(profile.age?.toString() ?? '');
  const [sex, setSex]                           = useState(profile.sex ?? '');
  const [heightCm, setHeightCm]                 = useState(profile.heightCm?.toString() ?? '');
  const [weightKg, setWeightKg]                 = useState(profile.weightKg?.toString() ?? '');
  const [timezone, setTimezone]                 = useState(profile.timezone ?? '');
  const [ftp, setFtp]                           = useState(profile.ftp?.toString() ?? '');
  const [experienceLevel, setExperienceLevel]   = useState(profile.experienceLevel ?? '');
  const [availableHoursWeek, setAvailableHours] = useState(profile.availableHoursWeek?.toString() ?? '');

  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    // Build payload with only fields that changed from original
    const body: Record<string, string | number> = {};
    if (name !== (profile.name ?? ''))                                       body.name = name;
    if (age !== (profile.age?.toString() ?? '') && age !== '')               body.age = Number(age);
    if (sex !== (profile.sex ?? ''))                                         body.sex = sex;
    if (heightCm !== (profile.heightCm?.toString() ?? '') && heightCm !== '') body.heightCm = Number(heightCm);
    if (weightKg !== (profile.weightKg?.toString() ?? '') && weightKg !== '') body.weightKg = Number(weightKg);
    if (timezone !== (profile.timezone ?? ''))                               body.timezone = timezone;
    if (ftp !== (profile.ftp?.toString() ?? '') && ftp !== '')               body.ftp = Number(ftp);
    if (experienceLevel !== (profile.experienceLevel ?? ''))                 body.experienceLevel = experienceLevel;
    if (availableHoursWeek !== (profile.availableHoursWeek?.toString() ?? '') && availableHoursWeek !== '')
      body.availableHoursWeek = Number(availableHoursWeek);

    try {
      const updated = await patchJson<AthleteProfile>('/api/athlete/profile', body);
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-t-2xl md:rounded-2xl w-full max-w-[500px] max-h-[85vh] flex flex-col animate-sheet-up md:mb-6 shadow-[0_-4px_30px_rgba(0,0,0,0.12)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-foreground">Edit Profile</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Scrollable form body */}
        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Identity</p>
          <div className="grid grid-cols-2 gap-3 mb-5">
            <Field label="Name">
              <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
            </Field>
            <Field label="Age">
              <input className={inputCls} type="number" min="1" max="120" value={age} onChange={e => setAge(e.target.value)} placeholder="e.g. 34" />
            </Field>
            <Field label="Sex">
              <select className={inputCls} value={sex} onChange={e => setSex(e.target.value)}>
                <option value="">—</option>
                {SEX_OPTIONS.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
              </select>
            </Field>
            <Field label="Height (cm)">
              <input className={inputCls} type="number" min="1" value={heightCm} onChange={e => setHeightCm(e.target.value)} placeholder="e.g. 178" />
            </Field>
            <Field label="Weight (kg)">
              <input className={inputCls} type="number" min="0" step="0.1" value={weightKg} onChange={e => setWeightKg(e.target.value)} placeholder="e.g. 72.5" />
            </Field>
            <Field label="Timezone">
              <input className={inputCls} value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="e.g. Europe/Madrid" />
            </Field>
          </div>

          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Training</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="FTP (watts)">
              <input className={inputCls} type="number" min="1" value={ftp} onChange={e => setFtp(e.target.value)} placeholder="e.g. 250" />
            </Field>
            <Field label="Hours / week">
              <input className={inputCls} type="number" min="0" step="0.5" value={availableHoursWeek} onChange={e => setAvailableHours(e.target.value)} placeholder="e.g. 10" />
            </Field>
            <Field label="Experience">
              <select className={inputCls} value={experienceLevel} onChange={e => setExperienceLevel(e.target.value)}>
                <option value="">—</option>
                {EXPERIENCE_OPTIONS.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
              </select>
            </Field>
          </div>

          {error && (
            <p className="mt-4 text-sm text-destructive">{error}</p>
          )}
        </form>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border shrink-0">
          <button
            type="submit"
            form="profile-edit-form"
            disabled={saving}
            onClick={handleSubmit}
            className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Check that `patchJson` exists in the api lib**

```bash
grep -n 'patchJson\|export' apps/web/src/lib/api.ts
```

If `patchJson` is not exported, add it. Read the file first, then add after the existing `getJson`/`postJson` functions:

```ts
export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd apps/web && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ProfileEditSheet.tsx apps/web/src/lib/api.ts
git commit -m "feat: add ProfileEditSheet component"
```

---

## Task 4: Wire pencil icon into AthleteHeroCard

**Files:**
- Modify: `apps/web/src/components/AthleteHeroCard.tsx`

- [ ] **Step 1: Update AthleteHeroCard**

Replace the full content of `apps/web/src/components/AthleteHeroCard.tsx` with:

```tsx
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronDown, Pencil } from 'lucide-react';
import { HERO_GRADIENT, HERO_SHADOW } from '@/components/shared';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { AthleteProfile } from '@/lib/api-types';
import { ProfileEditSheet } from '@/components/ProfileEditSheet';

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

export function AthleteHeroCard({ profile, maxHr, powerBests, thisWeek, onProfileName }: {
  profile: AthleteProfile;
  maxHr: number | null;
  powerBests: Record<string, number | null>;
  thisWeek?: { tss: number; hours: number; rides: number };
  onProfileName?: (name: string) => void;
}) {
  const [localProfile, setLocalProfile] = useState<AthleteProfile>(profile);
  const [showPower, setShowPower]       = useState(false);
  const [showEdit, setShowEdit]         = useState(false);

  const hasPower = powerBests && Object.values(powerBests).some(v => v != null);
  const p = localProfile;

  function handleSaved(updated: AthleteProfile) {
    setLocalProfile(updated);
    onProfileName?.(updated.name);
  }

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
    <>
      <Card className="text-[#f3f3f3]" style={{ background: HERO_GRADIENT, boxShadow: HERO_SHADOW }}>
        <CardContent>
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight flex-1 min-w-0 truncate">{p.name}</h1>
            <button
              type="button"
              onClick={() => setShowEdit(true)}
              className="shrink-0 p-1 rounded-md text-[#f3f3f3]/50 hover:text-[#f3f3f3] hover:bg-white/10 transition-colors"
              aria-label="Edit profile"
            >
              <Pencil className="w-4 h-4" />
            </button>
          </div>

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

      {showEdit && (
        <ProfileEditSheet
          profile={localProfile}
          onClose={() => setShowEdit(false)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Thread onProfileName from TodayTab**

In `apps/web/src/components/TodayTab.tsx` line 44, update the `AthleteHeroCard` call to pass `onProfileName`:

```tsx
<AthleteHeroCard profile={stats.profile} maxHr={stats.maxHr} powerBests={stats.powerBests} thisWeek={stats.thisWeek} onProfileName={onProfileName} />
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd apps/web && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke test in browser**

```bash
pnpm dev
```

- Open the app, confirm pencil icon is visible next to the athlete name on the hero card.
- Click the pencil — sheet slides up from the bottom on mobile viewport, centered modal on desktop.
- Edit the name field, click Save — hero card name updates immediately without page reload.
- Close with the ✕ button or by clicking the backdrop.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/AthleteHeroCard.tsx \
        apps/web/src/components/TodayTab.tsx
git commit -m "feat: wire profile edit sheet into AthleteHeroCard"
```

---

## Self-Review

**Spec coverage:**
- ✓ `PATCH /api/athlete/profile` with Zod validation → Task 1
- ✓ All 9 editable fields → Tasks 1, 3
- ✓ `AthleteProfile` type extended → Task 2
- ✓ `ProfileEditSheet` component with sheet pattern → Task 3
- ✓ Pencil icon entry point on hero card → Task 4
- ✓ Local profile state in `AthleteHeroCard` → Task 4
- ✓ `onProfileName` threading → Task 4
- ✓ Error handling (inline, sheet stays open) → Task 3
- ✓ Saving state on button → Task 3

**No placeholders found.**

**Type consistency:** `AthleteProfile` defined in Task 2 is used identically in Tasks 3 and 4. `patchJson<AthleteProfile>` return type matches what the PATCH route returns.
