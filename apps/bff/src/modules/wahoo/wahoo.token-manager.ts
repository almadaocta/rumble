import crypto from 'node:crypto';
import { db } from '../../db/client.js';
import { wahooConnections } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { wahooClient } from './wahoo.client.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKeyBuffer(): Buffer {
  return Buffer.from(config.ENCRYPTION_KEY, 'hex');
}

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKeyBuffer(), iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptToken(ciphertext: string): string {
  const data = Buffer.from(ciphertext, 'base64');

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKeyBuffer(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export class WahooTokenManager {
  private static readonly REFRESH_BUFFER_MS = 5 * 60 * 1000;

  async storeTokens(
    athleteId: string,
    wahooUserId: string,
    tokens: { access_token: string; refresh_token: string; expires_in: number },
    scopes?: string,
  ): Promise<void> {
    const encAccess = encryptToken(tokens.access_token);
    const encRefresh = encryptToken(tokens.refresh_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    await db
      .insert(wahooConnections)
      .values({
        athleteId,
        wahooUserId,
        accessToken: encAccess,
        refreshToken: encRefresh,
        tokenExpiresAt: expiresAt,
        scopes,
      })
      .onConflictDoUpdate({
        target: wahooConnections.athleteId,
        set: {
          wahooUserId,
          accessToken: encAccess,
          refreshToken: encRefresh,
          tokenExpiresAt: expiresAt,
          scopes,
        },
      });
  }

  async ensureValidToken(athleteId: string): Promise<string> {
    const [conn] = await db
      .select()
      .from(wahooConnections)
      .where(eq(wahooConnections.athleteId, athleteId))
      .limit(1);

    if (!conn) throw new Error('Wahoo not connected. Visit /api/wahoo/connect first.');

    const expiresAt = new Date(conn.tokenExpiresAt).getTime();
    const needsRefresh = Date.now() > expiresAt - WahooTokenManager.REFRESH_BUFFER_MS;

    if (!needsRefresh) {
      return decryptToken(conn.accessToken);
    }

    const refreshToken = decryptToken(conn.refreshToken);
    const refreshed = await this.refreshTokens(refreshToken);

    await db
      .update(wahooConnections)
      .set({
        accessToken: encryptToken(refreshed.accessToken),
        refreshToken: encryptToken(refreshed.refreshToken),
        tokenExpiresAt: refreshed.expiresAt,
      })
      .where(eq(wahooConnections.athleteId, athleteId));

    await this.revokeOldToken(refreshed.accessToken);

    return refreshed.accessToken;
  }

  async getConnectionByWahooUserId(wahooUserId: string) {
    const [conn] = await db
      .select()
      .from(wahooConnections)
      .where(eq(wahooConnections.wahooUserId, wahooUserId))
      .limit(1);
    return conn ?? null;
  }

  async updateLastSync(athleteId: string): Promise<void> {
    await db
      .update(wahooConnections)
      .set({ lastSyncAt: new Date() })
      .where(eq(wahooConnections.athleteId, athleteId));
  }

  async deleteConnection(athleteId: string): Promise<void> {
    const [conn] = await db
      .select()
      .from(wahooConnections)
      .where(eq(wahooConnections.athleteId, athleteId))
      .limit(1);

    if (conn) {
      try {
        const token = decryptToken(conn.accessToken);
        await this.revokeAccessToken(token);
      } catch {
        // Best effort revocation
      }

      await db.delete(wahooConnections).where(eq(wahooConnections.athleteId, athleteId));
    }
  }

  /**
   * Swaps a refresh token for a new pair.
   *
   * The HTTP lives on WahooClient; this file only translates the wire shape into
   * the expiry-bearing TokenSet it persists. Re-implementing the request here
   * means a second copy of the API host and the error formatting, and two places
   * that know how to talk to Wahoo.
   */
  private async refreshTokens(refreshToken: string): Promise<TokenSet> {
    const data = await wahooClient.refreshTokens(refreshToken);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  /**
   * Wahoo requires making an API call with the new token to revoke the old one.
   * GET /v1/user is lightweight and counts as the "activating" call.
   */
  private async revokeOldToken(newAccessToken: string): Promise<void> {
    try {
      await wahooClient.getUser(newAccessToken);
    } catch {
      // Non-critical — old token will eventually expire
    }
  }

  private async revokeAccessToken(token: string): Promise<void> {
    await wahooClient.revokeToken(token);
  }
}

export const wahooTokenManager = new WahooTokenManager();
