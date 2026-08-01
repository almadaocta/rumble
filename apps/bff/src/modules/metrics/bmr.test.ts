import { describe, it, expect } from 'vitest';
import { computeBmr, computeTarget } from './bmr.js';

describe('computeBmr', () => {
  it('computes male BMR correctly', () => {
    // 10×75 + 6.25×178 - 5×30 + 5 = 750 + 1112.5 - 150 + 5 = 1717.5 → 1718
    expect(computeBmr({ weightKg: 75, heightCm: 178, age: 30, sex: 'male' })).toBe(1718);
  });

  it('computes female BMR correctly', () => {
    // 10×60 + 6.25×165 - 5×28 - 161 = 600 + 1031.25 - 140 - 161 = 1330.25 → 1330
    expect(computeBmr({ weightKg: 60, heightCm: 165, age: 28, sex: 'female' })).toBe(1330);
  });

  it('averages male and female when sex is unknown', () => {
    const male = computeBmr({ weightKg: 75, heightCm: 178, age: 30, sex: 'male' })!;
    const female = computeBmr({ weightKg: 75, heightCm: 178, age: 30, sex: 'female' })!;
    const unknown = computeBmr({ weightKg: 75, heightCm: 178, age: 30, sex: null })!;
    expect(unknown).toBe(Math.round((male + female) / 2));
  });

  it('returns null when weight is missing', () => {
    expect(computeBmr({ weightKg: null, heightCm: 178, age: 30, sex: 'male' })).toBeNull();
  });

  it('returns null when height is missing', () => {
    expect(computeBmr({ weightKg: 75, heightCm: null, age: 30, sex: 'male' })).toBeNull();
  });

  it('returns null when age is missing', () => {
    expect(computeBmr({ weightKg: 75, heightCm: 178, age: null, sex: 'male' })).toBeNull();
  });
});

describe('computeTarget', () => {
  it('returns BMR when adjustment is 0 (maintenance)', () => {
    expect(computeTarget({ weightKg: 75, heightCm: 178, age: 30, sex: 'male' }, 0)).toBe(1718);
  });

  it('adds surplus correctly', () => {
    expect(computeTarget({ weightKg: 75, heightCm: 178, age: 30, sex: 'male' }, 300)).toBe(2018);
  });

  it('subtracts deficit correctly', () => {
    expect(computeTarget({ weightKg: 75, heightCm: 178, age: 30, sex: 'male' }, -500)).toBe(1218);
  });

  it('returns null when BMR cannot be computed', () => {
    expect(computeTarget({ weightKg: null, heightCm: 178, age: 30, sex: 'male' }, 0)).toBeNull();
  });
});
