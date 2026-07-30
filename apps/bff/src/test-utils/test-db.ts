// Shared setup for integration tests: applies the real schema migrations to
// the in-memory SQLite database (see vitest.setup.ts — DATABASE_PATH is
// forced to ':memory:' for every test run) and seeds athlete fixtures.
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from '../db/client.js';
import { athletes } from '../db/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '..', '..', 'drizzle');

let migrated = false;

/** Idempotent — safe to call in every test file's beforeAll. */
export function migrateTestDb(): void {
  if (migrated) return;
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  migrated = true;
}

export async function seedAthlete(name: string): Promise<string> {
  const [athlete] = await db.insert(athletes).values({ name }).returning();
  return athlete.id;
}
