import '../env.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from '../db/client.js';

// Resolved from this file, not the cwd. DATABASE_PATH is already cwd-relative,
// which is enough of a trap in this repo — running a script from the workspace
// root instead of apps/bff silently points it at a different, empty database.
// A migrations path with the same problem would fail confusingly rather than
// loudly, so it is anchored here.
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

async function main() {
  console.log('Running migrations...');
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log('Migrations complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
