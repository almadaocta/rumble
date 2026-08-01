export interface BiometricInputs {
  weightKg: number | null | undefined;
  heightCm: number | null | undefined;
  age: number | null | undefined;
  sex: string | null | undefined;
}

/**
 * Mifflin-St Jeor BMR in kcal/day.
 *
 * Male:   10×weight + 6.25×height − 5×age + 5
 * Female: 10×weight + 6.25×height − 5×age − 161
 * Unknown: average of male and female
 *
 * Returns null if any required input is missing.
 */
export function computeBmr(inputs: BiometricInputs): number | null {
  const { weightKg, heightCm, age, sex } = inputs;
  if (weightKg == null || heightCm == null || age == null) return null;

  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;

  if (sex === 'male') return Math.round(base + 5);
  if (sex === 'female') return Math.round(base - 161);
  // Unknown sex: average of both
  return Math.round((base + 5 + (base - 161)) / 2);
}

/**
 * Daily calorie target = BMR + adjustment.
 *
 * adjustment > 0: caloric surplus (muscle gain / fuelling)
 * adjustment < 0: caloric deficit (weight loss)
 * adjustment = 0: maintenance
 *
 * Returns null if BMR cannot be computed.
 */
export function computeTarget(inputs: BiometricInputs, dailyCalorieAdjustment: number): number | null {
  const bmr = computeBmr(inputs);
  if (bmr == null) return null;
  return bmr + dailyCalorieAdjustment;
}
