import { describe, it, expect } from 'vitest';
import { computeBestsFromPower, computeMaxHrFromStream } from './power-curve.js';

describe('computeBestsFromPower', () => {
  it('returns all-null bests for an empty stream', () => {
    const bests = computeBestsFromPower([]);
    expect(Object.values(bests).every((v) => v === null)).toBe(true);
  });

  it('finds the best 1s power as the single highest sample', () => {
    const bests = computeBestsFromPower([100, 250, 150, 90]);
    expect(bests.best1s).toBe(250);
  });

  it('finds the best rolling-window average, not just a single peak sample', () => {
    // 5 seconds at 300W surrounded by 0W — best3s should average the plateau, not spike to 300.
    const power = [0, 0, 300, 300, 300, 300, 300, 0, 0];
    const bests = computeBestsFromPower(power);
    expect(bests.best3s).toBe(300);
    expect(bests.best1s).toBe(300);
  });

  it('leaves a duration null when the stream is shorter than that window', () => {
    const bests = computeBestsFromPower([200, 210, 220]); // 3 samples, no 10s+ windows possible
    expect(bests.best10s).toBeNull();
    expect(bests.best3s).not.toBeNull();
  });

  it('never returns a best of 0 or below — treats it as no data', () => {
    const bests = computeBestsFromPower([0, 0, 0]);
    expect(bests.best1s).toBeNull();
  });
});

describe('computeMaxHrFromStream', () => {
  it('returns null for an empty stream', () => {
    expect(computeMaxHrFromStream([])).toBeNull();
  });

  it('returns the max value in the stream', () => {
    expect(computeMaxHrFromStream([120, 165, 140])).toBe(165);
  });

  it('treats an all-zero stream as no data', () => {
    expect(computeMaxHrFromStream([0, 0, 0])).toBeNull();
  });
});
