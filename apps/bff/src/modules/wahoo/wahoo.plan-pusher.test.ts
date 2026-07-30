/**
 * Regression tests for structured-workout expansion.
 *
 * `buildWahooPlanFile` expanded repeated interval sets with
 * `wahooIntervals.splice(-2)`, which carried two defects:
 *
 *  - it assumed the emitted block was always 2 steps (work + recovery), so a
 *    set with no recovery step swallowed whatever came before it — typically
 *    the warmup;
 *  - `splice` *removed* the block before pushing `repeats - 1` copies, so every
 *    set arrived on the athlete's head unit one repetition short.
 *
 * This is the first coverage the Wahoo subsystem has had.
 */
import { describe, it, expect } from 'vitest';
import { buildWahooPlanFile } from './wahoo.plan-pusher.js';

const FTP = 250;

function names(plan: ReturnType<typeof buildWahooPlanFile>): string[] {
  return plan.intervals.map((i) => i.name ?? '');
}

describe('buildWahooPlanFile repeats', () => {
  it('emits exactly `repeats` work steps when there is a recovery step', () => {
    const plan = buildWahooPlanFile('4x5 threshold', [
      { type: 'interval', name: 'threshold', duration_s: 300, power_pct: 0.98, rest_s: 180, rest_pct: 0.5, repeats: 4 },
    ], FTP);

    expect(names(plan).filter((n) => n === 'threshold')).toHaveLength(4);
    expect(names(plan).filter((n) => n === 'recovery')).toHaveLength(4);
  });

  it('emits exactly `repeats` work steps when there is no recovery step', () => {
    const plan = buildWahooPlanFile('3x steady', [
      { type: 'steady', name: 'tempo', duration_s: 600, power_pct: 0.85, repeats: 3 },
    ], FTP);

    expect(names(plan).filter((n) => n === 'tempo')).toHaveLength(3);
  });

  it('does not swallow the preceding interval when a set has no recovery step', () => {
    const plan = buildWahooPlanFile('warmup then 3x tempo', [
      { type: 'warmup', duration_s: 600 },
      { type: 'steady', name: 'tempo', duration_s: 600, power_pct: 0.85, repeats: 3 },
    ], FTP);

    const result = names(plan);
    // The warmup must survive, appear once, and stay at the front.
    expect(result.filter((n) => n === 'warmup')).toHaveLength(1);
    expect(result[0]).toBe('warmup');
    expect(result.filter((n) => n === 'tempo')).toHaveLength(3);
  });

  it('keeps a full session in order', () => {
    const plan = buildWahooPlanFile('full session', [
      { type: 'warmup', duration_s: 600 },
      { type: 'interval', name: 'vo2', duration_s: 240, power_pct: 1.15, rest_s: 240, rest_pct: 0.45, repeats: 5 },
      { type: 'cooldown', duration_s: 600 },
    ], FTP);

    const result = names(plan);
    expect(result[0]).toBe('warmup');
    expect(result[result.length - 1]).toBe('cooldown');
    expect(result.filter((n) => n === 'vo2')).toHaveLength(5);
    expect(result.filter((n) => n === 'recovery')).toHaveLength(5);
  });

  it('leaves a single-repetition interval untouched', () => {
    const plan = buildWahooPlanFile('one effort', [
      { type: 'warmup', duration_s: 600 },
      { type: 'interval', name: 'ftp test', duration_s: 1200, power_pct: 1.0, repeats: 1 },
    ], FTP);

    expect(names(plan)).toEqual(['warmup', 'ftp test']);
  });

  it('alternates work and recovery within a repeated set', () => {
    const plan = buildWahooPlanFile('3x threshold', [
      { type: 'interval', name: 'threshold', duration_s: 300, power_pct: 0.98, rest_s: 180, rest_pct: 0.5, repeats: 3 },
    ], FTP);

    expect(names(plan)).toEqual([
      'threshold', 'recovery',
      'threshold', 'recovery',
      'threshold', 'recovery',
    ]);
  });

  it('treats repeats: 0 as one repetition rather than dropping the interval', () => {
    const plan = buildWahooPlanFile('sloppy repeats', [
      { type: 'steady', name: 'tempo', duration_s: 600, power_pct: 0.85, repeats: 0 },
    ], FTP);

    expect(names(plan)).toEqual(['tempo']);
  });

  it('scales targets from FTP', () => {
    const plan = buildWahooPlanFile('tempo', [
      { type: 'steady', name: 'tempo', duration_s: 600, power_pct: 0.8 },
    ], FTP);

    const step = plan.intervals[0];
    expect(step.target_power_low).toBe(195); // 0.8 * 250 - 5
    expect(step.target_power_high).toBe(205);
  });
});
