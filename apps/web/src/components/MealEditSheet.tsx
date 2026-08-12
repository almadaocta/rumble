import { useState } from 'react';
import type { Meal } from '@/lib/api-types';
import { patchJson, deleteJson } from '@/lib/api';

// Mirrors MEAL_TYPES in apps/bff/src/modules/tools/vocabularies.ts — no
// build-time link between the two packages, so this is the seam that has to
// change if the backend vocabulary does.
const MEAL_TYPE_OPTIONS = ['breakfast', 'lunch', 'dinner', 'snack', 'pre_ride', 'during_ride', 'post_ride'];

function mealTypeLabel(v: string): string {
  return v.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

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

export function MealEditSheet({
  meal,
  onClose,
  onSaved,
  onDeleted,
}: {
  meal: Meal;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [description, setDescription] = useState(meal.description);
  const [mealType, setMealType]       = useState(meal.mealType ?? '');
  const [calories, setCalories]       = useState(meal.calories?.toString() ?? '');
  const [carbsG, setCarbsG]           = useState(meal.carbsG?.toString() ?? '');
  const [proteinG, setProteinG]       = useState(meal.proteinG?.toString() ?? '');
  const [fatG, setFatG]               = useState(meal.fatG?.toString() ?? '');

  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting]       = useState(false);

  async function submit() {
    setSaving(true);
    setError(null);

    const body: Record<string, string | number | null> = {};
    if (description !== meal.description)                                  body.description = description;
    if (mealType !== (meal.mealType ?? ''))                                 body.mealType = mealType || null;
    if (calories !== (meal.calories?.toString() ?? ''))                     body.calories = calories === '' ? null : Number(calories);
    if (carbsG !== (meal.carbsG?.toString() ?? ''))                         body.carbsG = carbsG === '' ? null : Number(carbsG);
    if (proteinG !== (meal.proteinG?.toString() ?? ''))                     body.proteinG = proteinG === '' ? null : Number(proteinG);
    if (fatG !== (meal.fatG?.toString() ?? ''))                             body.fatG = fatG === '' ? null : Number(fatG);

    if (Object.keys(body).length === 0) { onClose(); setSaving(false); return; }

    try {
      await patchJson(`/api/nutrition/${meal.id}`, body);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteJson(`/api/nutrition/${meal.id}`);
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete. Please try again.');
      setDeleting(false);
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
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-foreground">Edit Meal</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={e => { e.preventDefault(); void submit(); }} className="overflow-y-auto flex-1 px-5 py-4">
          <div className="flex flex-col gap-3">
            <Field label="Description" id="field-description">
              <input id="field-description" className={inputCls} value={description} onChange={e => setDescription(e.target.value)} placeholder="What did they eat?" />
            </Field>
            <Field label="Meal type" id="field-meal-type">
              <select id="field-meal-type" className={inputCls} value={mealType} onChange={e => setMealType(e.target.value)}>
                <option value="">—</option>
                {MEAL_TYPE_OPTIONS.map(o => <option key={o} value={o}>{mealTypeLabel(o)}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Calories" id="field-calories">
                <input id="field-calories" className={inputCls} type="number" min="0" value={calories} onChange={e => setCalories(e.target.value)} placeholder="e.g. 650" />
              </Field>
              <Field label="Carbs (g)" id="field-carbs">
                <input id="field-carbs" className={inputCls} type="number" min="0" value={carbsG} onChange={e => setCarbsG(e.target.value)} placeholder="e.g. 80" />
              </Field>
              <Field label="Protein (g)" id="field-protein">
                <input id="field-protein" className={inputCls} type="number" min="0" value={proteinG} onChange={e => setProteinG(e.target.value)} placeholder="e.g. 40" />
              </Field>
              <Field label="Fat (g)" id="field-fat">
                <input id="field-fat" className={inputCls} type="number" min="0" value={fatG} onChange={e => setFatG(e.target.value)} placeholder="e.g. 20" />
              </Field>
            </div>
          </div>

          {error && (
            <p className="mt-4 text-sm text-destructive">{error}</p>
          )}
        </form>

        <div className="px-5 py-4 border-t border-border shrink-0 flex flex-col gap-2">
          <button
            type="button"
            disabled={saving || deleting}
            onClick={() => void submit()}
            className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {confirmingDelete ? (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => void confirmDelete()}
                className="flex-1 rounded-md bg-destructive text-destructive-foreground px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {deleting ? 'Deleting…' : 'Confirm delete'}
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => setConfirmingDelete(false)}
                className="flex-1 rounded-md border border-border px-4 py-2 text-sm font-semibold hover:bg-accent disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={saving || deleting}
              onClick={() => setConfirmingDelete(true)}
              className="w-full rounded-md border border-destructive text-destructive px-4 py-2 text-sm font-semibold hover:bg-destructive/10 disabled:opacity-50 transition-colors"
            >
              Delete meal
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
