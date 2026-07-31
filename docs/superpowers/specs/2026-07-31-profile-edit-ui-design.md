# Profile Edit UI — Design Spec

**Date:** 2026-07-31

## Goal

Allow the athlete to edit their profile (name, weight, height, age, FTP, sex, available hours/week, experience level, timezone) directly from the dashboard without going through the coach chat.

---

## Entry Point

A `Pencil` icon (lucide-react) sits inline next to the athlete name in `AthleteHeroCard`. Clicking it opens `ProfileEditSheet`.

---

## Backend

### New route: `PATCH /api/athlete/profile`

**File:** `apps/bff/src/modules/athlete/athlete.controller.ts`

- Accepts a JSON body. All fields optional (partial update).
- Validated with Zod:

| Field | Type | Constraints |
|---|---|---|
| `name` | `string` | min 1 char |
| `weightKg` | `number` | positive |
| `heightCm` | `number` | positive integer |
| `age` | `number` | 1–120 integer |
| `ftp` | `number` | positive integer |
| `sex` | `string` | `'male' \| 'female' \| 'other'` |
| `availableHoursWeek` | `number` | positive |
| `experienceLevel` | `string` | `'beginner' \| 'intermediate' \| 'advanced' \| 'elite'` |
| `timezone` | `string` | any non-empty string (IANA tz) |

- Updates `athletes` row for `req.athleteId` using Drizzle.
- Returns updated profile: `{ name, ftp, weightKg, heightCm, age, sex, availableHoursWeek, experienceLevel, timezone, wkg }`.
  - `wkg` is recalculated server-side as `(ftp / weightKg).toFixed(2)` or `null`.

---

## Frontend

### Type update: `AthleteProfile`

**File:** `apps/web/src/lib/api-types.ts`

Add to `AthleteProfile`:
```ts
heightCm: number | null;
sex: string | null;
availableHoursWeek: number | null;
timezone: string | null;
```

### New component: `ProfileEditSheet`

**File:** `apps/web/src/components/ProfileEditSheet.tsx`

**Props:**
```ts
{
  profile: AthleteProfile;
  onClose: () => void;
  onSaved: (updated: AthleteProfile) => void;
}
```

**Layout:** Same pattern as `CalendarTab`'s `DetailSheet`:
- Fixed overlay: `fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end md:items-center justify-center animate-fade-in`
- Panel: `bg-card rounded-t-2xl md:rounded-2xl w-full max-w-[500px] max-h-[85vh] flex flex-col animate-sheet-up md:mb-6`
- Click backdrop to close, `stopPropagation` on panel.

**Sections:**

*Identity* — Name, Age, Sex (select: male/female/other), Height (cm), Weight (kg), Timezone (text input)

*Training* — FTP (watts), Experience level (select: beginner/intermediate/advanced/elite), Available hours/week

**Form behavior:**
- Pre-filled from `profile` prop.
- Local `useState` for each field value.
- `saving` boolean state drives button disabled + label ("Save" → "Saving…").
- On submit: `PATCH /api/athlete/profile` with only changed fields (diff against original prop).
- On success: call `onSaved(updatedProfile)`, close sheet.
- On error: show inline error message below the save button. Sheet stays open.

### Changes to `AthleteHeroCard`

**File:** `apps/web/src/components/AthleteHeroCard.tsx`

- Add `onProfileName?: (name: string) => void` prop (passed through from `TodayTab`).
- Local `useState<AthleteProfile>` initialised from the `profile` prop — replaces direct `p` usage.
- `showEdit` boolean state controls `ProfileEditSheet` visibility.
- Pencil icon button next to `{p.name}` in the `<h1>` row.
- `onSaved` callback: update local profile state, call `onProfileName?.(updated.name)`.

### Changes to `TodayTab`

**File:** `apps/web/src/components/TodayTab.tsx`

- Pass `onProfileName` down to `AthleteHeroCard` (it already receives it; just thread it through).

---

## Data Flow

```
TodayTab (fetches /api/athlete/stats)
  └── AthleteHeroCard
        ├── local useState(profile)   ← initialised from prop, updated on save
        ├── Pencil icon → showEdit=true
        └── ProfileEditSheet
              ├── PATCH /api/athlete/profile
              └── onSaved → update local state + call onProfileName
```

---

## Error Handling

- Network/server error: inline message below save button, sheet stays open, fields remain editable.
- Validation errors from Zod (400 response): display the error message from the response body.

---

## Out of Scope

- `coachingTone` slider — coach-managed, not exposed here.
- `primaryGoal` — free text managed via coach chat.
- Email — no auth system yet.
- Unit conversion (lbs ↔ kg, ft ↔ cm) — store in metric only.
