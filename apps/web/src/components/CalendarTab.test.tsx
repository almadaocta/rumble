// @vitest-environment jsdom
/**
 * The month grid — the app's largest component and, until now, untested.
 *
 * The case worth pinning is a session and an activity falling on the same day:
 * mergeDays keys them from different fields (scheduledDate vs startedAt) and
 * they have to land in one cell. That merge is where a timezone bug already
 * lived once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CalendarTab } from './CalendarTab';
import { localDateKey } from '@/lib/calendar';

// Deliberately NOT on fake timers, unlike the BFF's date-sensitive tests:
// @testing-library's waitFor polls on real timers, and freezing them starves it
// until the test times out. The exposure here is also far smaller — the fixture
// and the component read the clock in the same tick, so they can only disagree
// if a run crosses midnight in between.
const FIXED_NOW = new Date();
const TODAY = localDateKey(FIXED_NOW);

/** Routes each endpoint the component fetches to a canned body. */
function mockApi(bodies: { sessions?: unknown[]; activities?: unknown[] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      const body = url.includes('/api/activities')
        ? { activities: bodies.activities ?? [] }
        : url.includes('/api/athlete/sessions')
          ? { sessions: bodies.sessions ?? [], plan: null }
          : { connected: false, syncStatus: 'idle', activityCount: 0, lastSyncAt: null };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    }),
  );
}

const session = {
  id: 's1',
  scheduledDate: TODAY,
  sessionType: 'threshold',
  title: 'Threshold intervals',
  description: null,
  targetTss: 85,
  targetDurationMin: 60,
  targetIf: null,
  completed: false,
  feedbackRpe: null,
};

const activity = {
  id: 'a1',
  type: 'ride',
  name: 'Morning ride',
  startedAt: FIXED_NOW.toISOString(),
  durationS: 3600,
  distanceM: 30000,
  avgPower: 210,
  normPower: 225,
  tss: 80,
  calories: 700,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CalendarTab', () => {
  it('renders an empty month without crashing', async () => {
    mockApi({});
    render(<CalendarTab />);

    // The month heading is always present, even with no data.
    await waitFor(() => {
      expect(screen.getByText('History')).toBeInTheDocument();
    });
  });

  it('shows the planned session for a day with no ride yet', async () => {
    mockApi({ sessions: [session], activities: [] });
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Threshold intervals')).toBeInTheDocument();
    });
  });

  it('shows the ride instead of the plan once the day has an activity', async () => {
    // Deliberate: what the athlete actually did supersedes what was planned, so
    // the day panel lists activities and hides the session when both exist.
    mockApi({ sessions: [session], activities: [activity] });
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Morning ride')).toBeInTheDocument();
    });
    expect(screen.queryByText('Threshold intervals')).not.toBeInTheDocument();
  });

  it('shows the legend only for types present this month', async () => {
    mockApi({ sessions: [session], activities: [] });
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Threshold')).toBeInTheDocument();
    });
    // Types absent from this month must not be legended.
    expect(screen.queryByText('VO2 Max')).not.toBeInTheDocument();
  });

  it('survives a failed fetch rather than rendering a broken month', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('History')).toBeInTheDocument();
    });
  });

  it('reports a failed month load instead of spinning forever', async () => {
    // loadMonth had no failure path: a rejection skipped setLoading(false)
    // along with setDayMap, leaving the spinner turning with nothing to say.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<CalendarTab />);

    await waitFor(() => {
      expect(screen.getByText('Could not load this month.')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
