import { describe, it, expect } from 'vitest';
import { tsbLabel, tsbIntensity } from './training';

describe('tsbLabel', () => {
  it('labels a strongly positive TSB as Fresh', () => {
    expect(tsbLabel(10)).toBe('Fresh');
  });

  it('labels a strongly negative TSB as Fatigued', () => {
    expect(tsbLabel(-15)).toBe('Fatigued');
  });

  it('labels values in between as Neutral', () => {
    expect(tsbLabel(0)).toBe('Neutral');
    expect(tsbLabel(5)).toBe('Neutral'); // boundary itself is not > 5
    expect(tsbLabel(-10)).toBe('Neutral'); // boundary itself is not < -10
  });
});

describe('tsbIntensity', () => {
  it('matches the Fatigued boundary (-10) at 0', () => {
    expect(tsbIntensity(-10)).toBe(0);
  });

  it('matches the Fresh boundary (+5) at 1', () => {
    expect(tsbIntensity(5)).toBe(1);
  });

  it('clamps below the Fatigued boundary to 0', () => {
    expect(tsbIntensity(-30)).toBe(0);
  });

  it('clamps above the Fresh boundary to 1', () => {
    expect(tsbIntensity(20)).toBe(1);
  });

  it('is linear between the two boundaries', () => {
    // Midpoint of -10..5 is -2.5, so intensity should be 0.5
    expect(tsbIntensity(-2.5)).toBeCloseTo(0.5, 5);
  });
});
