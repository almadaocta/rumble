import { z } from 'zod';
import { config } from '../../config.js';

const BASE_URL = 'https://api.wahooligan.com';

/**
 * Scopes requested at authorization and recorded against the stored connection.
 *
 * One constant because the two have to agree and nothing else makes them. With a
 * hand-copied duplicate in the controller, adding a scope to the authorize URL
 * and forgetting the copy records a connection whose stated permissions don't
 * match what the athlete actually granted.
 */
export const WAHOO_SCOPES =
  'user_read workouts_read workouts_write plans_read plans_write power_zones_read power_zones_write routes_write offline_data';

interface PaginationParams {
  page?: number;
  per_page?: number;
}

/** What Wahoo's /oauth/token returns for both the code and refresh grants. */
export interface WahooTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class WahooClient {
  async exchangeCode(code: string): Promise<WahooTokenResponse> {
    return this.postForm<WahooTokenResponse>('/oauth/token', 'code exchange', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.WAHOO_REDIRECT_URI,
    });
  }

  async refreshTokens(refreshToken: string): Promise<WahooTokenResponse> {
    return this.postForm<WahooTokenResponse>('/oauth/token', 'token refresh', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  /**
   * Revokes an access token. Best effort — callers use this while tearing a
   * connection down, where a failure to revoke should not block the local
   * delete, so the response body is not read and non-2xx is not thrown on.
   */
  async revokeToken(token: string): Promise<void> {
    await fetch(`${BASE_URL}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        client_id: config.WAHOO_CLIENT_ID,
        client_secret: config.WAHOO_CLIENT_SECRET,
      }),
    });
  }

  async getUser(token: string): Promise<WahooUser> {
    return this.get<WahooUser>('/v1/user', token);
  }

  async getWorkouts(token: string, params?: PaginationParams): Promise<WahooWorkoutResponse> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.per_page) qs.set('per_page', String(params.per_page));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.get<WahooWorkoutResponse>(`/v1/workouts${query}`, token);
  }


  async getPowerZones(token: string): Promise<WahooPowerZones> {
    return this.get<WahooPowerZones>('/v1/power_zones', token);
  }

  async putPowerZones(token: string, zones: WahooPowerZoneUpdate): Promise<void> {
    await this.put('/v1/power_zones', token, { power_zones: zones });
  }

  async createPlan(
    token: string,
    plan: { file: string; filename: string; external_id: string; provider_updated_at: string },
  ): Promise<{ id: number }> {
    return this.post<{ id: number }>('/v1/plans', token, { plan });
  }

  async createWorkout(
    token: string,
    workout: {
      name: string;
      workout_token: string;
      workout_type_id: number;
      starts: string;
      minutes: number;
      plan_id: number;
    },
  ): Promise<{ id: number }> {
    return this.post<{ id: number }>('/v1/workouts', token, { workout });
  }

  /**
   * `state` is required, not optional.
   *
   * It is the only thing tying the code that comes back to a flow this app
   * started. Without it, /callback exchanges whatever code it is handed and
   * binds the resulting connection to the local athlete — so anyone who can get
   * the athlete's browser to load the callback URL with a code from their own
   * Wahoo account attaches that account to this athlete's training data.
   */
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: config.WAHOO_CLIENT_ID,
      redirect_uri: config.WAHOO_REDIRECT_URI,
      response_type: 'code',
      scope: WAHOO_SCOPES,
      state,
    });
    return `${BASE_URL}/oauth/authorize?${params.toString()}`;
  }

  /**
   * Form-encoded POST to an OAuth endpoint, with the client credentials added.
   *
   * `what` names the operation in the thrown message — Wahoo answers both
   * grants on the same path, so the path alone doesn't say which one failed.
   */
  private async postForm<T>(
    path: string,
    what: string,
    fields: Record<string, string>,
  ): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...fields,
        client_id: config.WAHOO_CLIENT_ID,
        client_secret: config.WAHOO_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Wahoo ${what} failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private async get<T>(path: string, token: string): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Wahoo GET ${path} failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private async post<T>(path: string, token: string, body: unknown): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Wahoo POST ${path} failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private async put(path: string, token: string, body: unknown): Promise<void> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Wahoo PUT ${path} failed (${response.status}): ${text}`);
    }
  }
}

export interface WahooUser {
  id: number;
  email: string;
  first: string;
  last: string;
  height: string;
  weight: string;
  gender: number;
  birth: string;
}

/**
 * Wahoo reports every measurement as a decimal string, and omits the ones a
 * given workout has no data for — a ride with no power meter simply has no
 * power_avg key. Hence `.nullish()`: declaring them all as required `string` is
 * false even for real payloads, and it is what makes asserting an arbitrary JSON
 * body into the normalizer look safe.
 */
const NumericString = z.string().nullish();

/**
 * The metadata a summary needs to become an activity. Present inline on webhook
 * payloads; on the paged /v1/workouts response it lives on the parent workout
 * and is passed to the normalizer separately.
 */
const WahooWorkoutMeta = z.object({
  id: z.number(),
  starts: z.string(),
  minutes: z.number().nullish(),
  name: z.string().nullish(),
  workout_type_id: z.number(),
  plan_id: z.number().nullable().optional(),
});

/**
 * Validated at the webhook boundary, where the body is whatever was POSTed.
 *
 * `.passthrough()` because Wahoo adds fields and none of them are a reason to
 * drop an athlete's ride on the floor.
 */
export const WahooWorkoutSummarySchema = z
  .object({
    id: z.number(),
    // The one measurement that isn't optional: it's parsed directly rather than
    // through the nonZero* helpers, and an activity with no duration is not one.
    duration_active_accum: z.string(),
    ascent_accum: NumericString,
    cadence_avg: NumericString,
    calories_accum: NumericString,
    distance_accum: NumericString,
    duration_paused_accum: NumericString,
    duration_total_accum: NumericString,
    heart_rate_avg: NumericString,
    heart_rate_max: NumericString,
    power_bike_np_last: NumericString,
    power_bike_tss_last: NumericString,
    power_avg: NumericString,
    power_max: NumericString,
    speed_avg: NumericString,
    work_accum: NumericString,
    file: z.object({ url: z.string().nullable() }).nullish(),
    workout: WahooWorkoutMeta.nullish(),
  })
  .passthrough();

/** Inferred from the schema, so the type and the validation cannot disagree. */
export type WahooWorkoutSummary = z.infer<typeof WahooWorkoutSummarySchema>;

export interface WahooWorkoutResponse {
  workouts: Array<{
    id: number;
    starts: string;
    minutes: number;
    name: string;
    workout_type_id: number;
    plan_id: number | null;
    workout_summary: WahooWorkoutSummary | null;
  }>;
  total: number;
  page: number;
  per_page: number;
  order: string;
  sort: string;
}

export interface WahooPowerZones {
  power_zones: Array<{
    zone: number;
    min: number;
    max: number;
  }>;
  ftp: number;
}

export interface WahooPowerZoneUpdate {
  zones: Array<{ zone: number; min: number; max: number }>;
}

export const wahooClient = new WahooClient();
