/**
 * Small formatting helpers shared across BFF modules.
 *
 * Both of these are one-liners that want copying — `formatDuration` into every
 * tool handler that renders a session, and `toISOString().split('T')[0]` into
 * anything that needs today's date. Keeping them here is mostly about the
 * second: it gives the UTC-versus-athlete-timezone question one home instead of
 * a call site per module, each silently assuming UTC.
 */

/** Seconds as `2h 15m`, or `45m` under an hour. */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * `YYYY-MM-DD` in UTC.
 *
 * Named for its clock deliberately. Most callers want "today" for an athlete
 * whose timezone lives on their profile, and UTC is only an acceptable
 * approximation while the app serves a single local user. The name is here so
 * that assumption is visible when it stops holding — see the same distinction
 * in the web app's localDateKey/utcDateKey pair.
 */
export function utcDateString(d: Date = new Date()): string {
  return d.toISOString().split('T')[0];
}
