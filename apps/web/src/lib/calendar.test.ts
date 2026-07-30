import { describe, it, expect } from 'vitest';
import { utcDateKey, localDateKey, mergeDays, buildMonthGrid } from './calendar';

describe('utcDateKey', () => {
  it('extracts the YYYY-MM-DD date from an ISO timestamp, in UTC', () => {
    expect(utcDateKey('2026-03-05T14:30:00Z')).toBe('2026-03-05');
  });
});

describe('localDateKey', () => {
  it('formats a Date as YYYY-MM-DD with zero-padding', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05'); // month 0 = January
    expect(localDateKey(new Date(2026, 10, 20))).toBe('2026-11-20');
  });

  it('uses the local calendar day, which is the whole point of the name', () => {
    // Constructed from local components, so this is local midnight whatever the
    // runner's timezone — and must not shift to the previous/next day the way
    // a UTC key would east or west of Greenwich.
    const localMidnight = new Date(2026, 2, 6, 0, 30);
    expect(localDateKey(localMidnight)).toBe('2026-03-06');
  });
});

describe('mergeDays', () => {
  it('groups sessions by their scheduled date', () => {
    const sessions = [{ scheduledDate: '2026-03-05' }, { scheduledDate: '2026-03-05' }];
    const map = mergeDays(sessions, []);
    expect(map.get('2026-03-05')?.sessions).toHaveLength(2);
  });

  it('groups activities by the date extracted from startedAt', () => {
    const activities = [{ startedAt: '2026-03-06T08:00:00Z' }];
    const map = mergeDays([], activities);
    expect(map.get('2026-03-06')?.activities).toHaveLength(1);
  });

  it('keys activities on the same clock the month grid uses', () => {
    // The grid is built with localDateKey, so an activity must land on the key
    // localDateKey would produce for the same instant. This used to use a UTC
    // key, which put any ride between local midnight and UTC midnight on the
    // wrong cell — invisible in UTC, wrong for every athlete east of Greenwich.
    //
    // Sweeping the whole day means at least one instant straddles the boundary
    // in any non-UTC timezone, so this catches the regression wherever it runs.
    for (let hour = 0; hour < 24; hour++) {
      const instant = new Date(2026, 2, 6, hour, 30);
      const map = mergeDays([], [{ startedAt: instant.toISOString() }]);
      const expectedKey = localDateKey(instant);
      expect(map.get(expectedKey)?.activities, `hour ${hour}`).toHaveLength(1);
    }
  });

  it('merges a session and an activity on the same day into one entry', () => {
    const map = mergeDays(
      [{ scheduledDate: '2026-03-05' }],
      [{ startedAt: '2026-03-05T08:00:00Z' }],
    );
    const day = map.get('2026-03-05');
    expect(day?.sessions).toHaveLength(1);
    expect(day?.activities).toHaveLength(1);
  });

  it('returns an empty map for no input', () => {
    expect(mergeDays([], []).size).toBe(0);
  });
});

describe('buildMonthGrid', () => {
  it('covers every day of the month', () => {
    const grid = buildMonthGrid(new Date(2026, 1, 1)); // Feb 2026
    for (let day = 1; day <= 28; day++) {
      expect(grid).toContain(`2026-02-${String(day).padStart(2, '0')}`);
    }
  });

  it('pads to whole weeks (length is always a multiple of 7)', () => {
    const grid = buildMonthGrid(new Date(2026, 1, 1));
    expect(grid.length % 7).toBe(0);
  });

  it('includes leading days from the prior month to fill the first week', () => {
    // April 1, 2026 is a Wednesday, so the grid must pad backward into March.
    const grid = buildMonthGrid(new Date(2026, 3, 1));
    expect(grid[0]).toBe('2026-03-29'); // the Sunday before April 1
    expect(grid[0].startsWith('2026-04-')).toBe(false);
  });
});
