export interface DayData<Session, Activity> {
  date: string;
  sessions: Session[];
  activities: Activity[];
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `YYYY-MM-DD` in the viewer's own timezone.
 *
 * The calendar grid is built from local dates, so everything placed on it has
 * to agree. Named for its clock because the previous pair — `dateKey` and
 * `toDateKey` — read as synonyms while silently using different ones.
 */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD` in UTC. Only correct where the value is genuinely UTC-anchored. */
export function utcDateKey(iso: string): string {
  return new Date(iso).toISOString().split('T')[0];
}

export function mergeDays<S extends { scheduledDate: string }, A extends { startedAt: string }>(
  sessions: S[],
  activities: A[],
): Map<string, DayData<S, A>> {
  const map = new Map<string, DayData<S, A>>();
  for (const s of sessions) {
    const k = s.scheduledDate;
    if (!map.has(k)) map.set(k, { date: k, sessions: [], activities: [] });
    map.get(k)!.sessions.push(s);
  }
  for (const a of activities) {
    // Local, not UTC: buildMonthGrid below keys its cells with localDateKey, so
    // a UTC key put any ride recorded between local midnight and UTC midnight
    // on the wrong day — or on a key with no cell at all. Visible for any
    // athlete east of Greenwich, which includes this app's default timezone.
    const k = localDateKey(new Date(a.startedAt));
    if (!map.has(k)) map.set(k, { date: k, sessions: [], activities: [] });
    map.get(k)!.activities.push(a);
  }
  return map;
}

/** Full grid of date keys (padded to whole weeks) covering the given month. */
export function buildMonthGrid(viewDate: Date): string[] {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

  const start = new Date(year, month, 1 - firstWeekday);
  const dates: string[] = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    dates.push(localDateKey(d));
  }
  return dates;
}
