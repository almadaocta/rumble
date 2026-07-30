import { describe, it, expect } from 'vitest';
import { emaStep, round1, CTL_DAYS, ATL_DAYS, classifyForm, formLabel, TSB_BANDS } from './training-load.js';

describe('emaStep', () => {
  it('leaves the average unchanged when today matches it', () => {
    expect(emaStep(50, 50, CTL_DAYS)).toBe(50);
  });

  it('moves the average toward today by 1/days of the gap', () => {
    // previous=0, today=42, days=42 -> moves by exactly (42-0)/42 = 1
    expect(emaStep(0, 42, 42)).toBe(1);
  });

  it('decreases the average when today is lower (e.g. a rest day, TSS=0)', () => {
    const next = emaStep(80, 0, ATL_DAYS);
    expect(next).toBeLessThan(80);
    expect(next).toBeCloseTo(80 - 80 / ATL_DAYS, 5);
  });

  it('ATL reacts faster than CTL to the same daily value, by design', () => {
    const prev = 50;
    const today = 100;
    const ctlNext = emaStep(prev, today, CTL_DAYS);
    const atlNext = emaStep(prev, today, ATL_DAYS);
    expect(atlNext - prev).toBeGreaterThan(ctlNext - prev);
  });
});

describe('round1', () => {
  it('rounds to one decimal place', () => {
    expect(round1(1.23456)).toBe(1.2);
    expect(round1(1.25)).toBe(1.3);
    expect(round1(-0.05)).toBe(-0.1);
  });
});

describe('TSB form classification', () => {
  it('classifies the six bands at their documented cut-points', () => {
    expect(classifyForm(null)).toBe('unknown');
    expect(classifyForm(20)).toBe('very_fresh');
    expect(classifyForm(10)).toBe('fresh');
    expect(classifyForm(0)).toBe('neutral');
    expect(classifyForm(-15)).toBe('fatigued');
    expect(classifyForm(-25)).toBe('very_fatigued');
  });

  it('treats each cut-point as exclusive, so a boundary value falls to the lower band', () => {
    expect(classifyForm(TSB_BANDS.veryFresh)).toBe('fresh');
    expect(classifyForm(TSB_BANDS.fresh)).toBe('neutral');
    expect(classifyForm(TSB_BANDS.neutral)).toBe('fatigued');
    expect(classifyForm(TSB_BANDS.fatigued)).toBe('very_fatigued');
  });

  it('collapses to the coarse three-way label used in prose', () => {
    expect(formLabel(10)).toBe('fresh');
    expect(formLabel(0)).toBe('neutral');
    expect(formLabel(-15)).toBe('fatigued');
  });

  it('agrees with the six-way classification about what counts as fatigued', () => {
    // The dashboard label and the coach's wording must not disagree.
    for (const tsb of [-30, -20, -11, -10, 0, 5, 6, 20]) {
      const coarse = formLabel(tsb);
      const fine = classifyForm(tsb);
      if (coarse === 'fatigued') expect(fine).toMatch(/fatigued/);
      if (coarse === 'fresh') expect(fine).toMatch(/fresh/);
    }
  });
});
