import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Loads .env from the app directory, falling back to the workspace root.
 *
 * No `override`, which is dotenv's default and the right way round: a real
 * environment variable beats the file. Overriding inverts that, so a value
 * exported in the shell or set by a CI job is silently replaced by whatever a
 * checked-out .env happens to say — and any caller wanting to set one before
 * this runs has to know to sequence around it.
 */
const candidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
];

for (const envPath of candidates) {
  if (existsSync(envPath)) {
    loadEnv({ path: envPath });
    break;
  }
}
