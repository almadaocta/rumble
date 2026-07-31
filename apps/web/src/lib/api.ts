/**
 * The one place a GET against the BFF is turned into data.
 *
 * Every read site repeated the same three steps — fetch, bail on a non-2xx,
 * parse — and each hand-rolled its own fallback, so a failed read variously
 * became null, an empty array, or a partially-populated component.
 *
 * This rejects rather than returning null. Swallowing failures into null makes
 * "the request failed" and "there is nothing here" the same value: an offline
 * calendar renders as a month with no rides, and a component whose only failure
 * branch is a `.catch` sits on its spinner forever waiting for a rejection that
 * never comes. Callers that genuinely don't act on the difference opt in with
 * `.catch(() => null)`, which at least says so.
 *
 * The BFF answers every failure with a non-2xx and an { error } body (see
 * middleware/error-handler.ts), so that message is what surfaces.
 *
 * Writes deliberately do not go through here: each one needs to surface its own
 * failure to the athlete, and flattening that into a null return is what let
 * sync failures pass silently in the first place.
 */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }

  return (await res.json()) as T;
}

/**
 * The write counterpart. Rejects with the BFF's `{ error }` message on any
 * failure, so the caller can put it in front of the athlete.
 *
 * Writes surface their own failures — that part is deliberate, and is why this
 * rejects rather than returning a status. What it takes off the callers is
 * `res.json()`, whose `any` otherwise gets destructured straight into an
 * `alert`, twice per call site (once for the error path, once for the success
 * payload) with a different inline fallback shape each time.
 *
 * Returns null when there is no JSON body — a 204, or an endpoint that just
 * says "ok" with a status.
 */
export async function postJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(path, { method: 'POST', ...init });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!res.ok) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }

  return body;
}

/**
 * The PATCH counterpart. Rejects with the BFF's `{ error }` message on any
 * failure. Used for partial updates where only changed fields are sent.
 */
export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
