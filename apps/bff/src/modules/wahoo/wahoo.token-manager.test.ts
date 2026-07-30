/**
 * Tests for OAuth token encryption at rest.
 *
 * These are the app's only credentials for a third-party account, stored in the
 * same SQLite file as everything else, and this crypto had no coverage at all.
 * AES-256-GCM is authenticated, so tampering must fail loudly rather than
 * returning garbage plaintext — that guarantee is worth pinning.
 */
import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from './wahoo.token-manager.js';

const IV_LENGTH = 16;
const TAG_LENGTH = 16;

describe('token encryption', () => {
  it('round-trips a token', () => {
    const token = 'wahoo_access_abc123.def456';
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it('does not leave the plaintext visible in the stored value', () => {
    const token = 'super-secret-refresh-token';
    const stored = encryptToken(token);
    expect(stored).not.toContain(token);
    expect(Buffer.from(stored, 'base64').toString('utf8')).not.toContain(token);
  });

  it('produces a different ciphertext each time, so equal tokens are not linkable', () => {
    const token = 'identical-token';
    const a = encryptToken(token);
    const b = encryptToken(token);

    expect(a).not.toBe(b); // random IV per encryption
    expect(decryptToken(a)).toBe(token);
    expect(decryptToken(b)).toBe(token);
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const stored = Buffer.from(encryptToken('tamper-me'), 'base64');
    // Flip a bit in the encrypted body, past the IV and auth tag.
    stored[IV_LENGTH + TAG_LENGTH] ^= 0xff;

    expect(() => decryptToken(stored.toString('base64'))).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const stored = Buffer.from(encryptToken('tamper-the-tag'), 'base64');
    stored[IV_LENGTH] ^= 0xff;

    expect(() => decryptToken(stored.toString('base64'))).toThrow();
  });

  it('rejects a truncated value instead of decrypting a prefix', () => {
    const stored = Buffer.from(encryptToken('truncate-me'), 'base64');
    expect(() => decryptToken(stored.subarray(0, 20).toString('base64'))).toThrow();
  });

  it('handles tokens with unicode and unusual lengths', () => {
    for (const token of ['', 'a', 'ünïcode-tøken-✓', 'x'.repeat(4096)]) {
      expect(decryptToken(encryptToken(token))).toBe(token);
    }
  });
});
