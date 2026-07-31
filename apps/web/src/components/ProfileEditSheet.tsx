import { useState } from 'react';
import type { AthleteProfile } from '@/lib/api-types';
import { patchJson } from '@/lib/api';

const EXPERIENCE_OPTIONS = ['beginner', 'intermediate', 'advanced', 'elite'];
const SEX_OPTIONS = ['male', 'female', 'other'];

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</label>
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

  async function submit() {
    setSaving(true);
    setError(null);

    // Build payload with only fields that changed from original
    const body: Record<string, string | number> = {};
    if (name !== (profile.name ?? ''))                                        body.name = name;
    if (age !== (profile.age?.toString() ?? '') && age !== '')                body.age = Number(age);
    if (sex !== (profile.sex ?? ''))                                          body.sex = sex;
    if (heightCm !== (profile.heightCm?.toString() ?? '') && heightCm !== '') body.heightCm = Number(heightCm);
    if (weightKg !== (profile.weightKg?.toString() ?? '') && weightKg !== '') body.weightKg = Number(weightKg);
    if (timezone !== (profile.timezone ?? ''))                                body.timezone = timezone;
    if (ftp !== (profile.ftp?.toString() ?? '') && ftp !== '')                body.ftp = Number(ftp);
    if (experienceLevel !== (profile.experienceLevel ?? ''))                  body.experienceLevel = experienceLevel;
    if (availableHoursWeek !== (profile.availableHoursWeek?.toString() ?? '') && availableHoursWeek !== '')
      body.availableHoursWeek = Number(availableHoursWeek);

    // Guard: nothing changed — just close
    if (Object.keys(body).length === 0) { onClose(); setSaving(false); return; }

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
        <form onSubmit={e => { e.preventDefault(); void submit(); }} className="overflow-y-auto flex-1 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Identity</p>
          <div className="grid grid-cols-2 gap-3 mb-5">
            <Field label="Name" id="field-name">
              <input id="field-name" className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
            </Field>
            <Field label="Age" id="field-age">
              <input id="field-age" className={inputCls} type="number" min="1" max="120" value={age} onChange={e => setAge(e.target.value)} placeholder="e.g. 34" />
            </Field>
            <Field label="Sex" id="field-sex">
              <select id="field-sex" className={inputCls} value={sex} onChange={e => setSex(e.target.value)}>
                <option value="">—</option>
                {SEX_OPTIONS.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
              </select>
            </Field>
            <Field label="Height (cm)" id="field-height">
              <input id="field-height" className={inputCls} type="number" min="1" value={heightCm} onChange={e => setHeightCm(e.target.value)} placeholder="e.g. 178" />
            </Field>
            <Field label="Weight (kg)" id="field-weight">
              <input id="field-weight" className={inputCls} type="number" min="0" step="0.1" value={weightKg} onChange={e => setWeightKg(e.target.value)} placeholder="e.g. 72.5" />
            </Field>
            <Field label="Timezone" id="field-timezone">
              <input id="field-timezone" className={inputCls} value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="e.g. Europe/Madrid" />
            </Field>
          </div>

          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Training</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="FTP (watts)" id="field-ftp">
              <input id="field-ftp" className={inputCls} type="number" min="1" value={ftp} onChange={e => setFtp(e.target.value)} placeholder="e.g. 250" />
            </Field>
            <Field label="Hours / week" id="field-hours">
              <input id="field-hours" className={inputCls} type="number" min="0" step="0.5" value={availableHoursWeek} onChange={e => setAvailableHours(e.target.value)} placeholder="e.g. 10" />
            </Field>
            <Field label="Experience" id="field-experience">
              <select id="field-experience" className={inputCls} value={experienceLevel} onChange={e => setExperienceLevel(e.target.value)}>
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
            type="button"
            disabled={saving}
            onClick={() => void submit()}
            className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
