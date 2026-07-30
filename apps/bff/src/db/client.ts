import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import * as schema from './schema.js';

type Db = BetterSQLite3Database<typeof schema>;

let instance: Db | undefined;

/**
 * The database handle, opened on first use.
 *
 * Opening at module scope makes importing *anything* that touches persistence —
 * 27 modules, transitively most of the app — create a directory and open a
 * SQLite file. That is why a unit test for a pure function like
 * computeBestsFromPower needed a working DATABASE_PATH, and why a mis-set path
 * failed at import with a stack trace pointing here rather than at whatever
 * asked for a query.
 */
export function getDb(): Db {
  if (instance) return instance;

  // ':memory:' has no directory to create; mkdirSync on it makes a stray '.'.
  if (config.DATABASE_PATH !== ':memory:') {
    mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
  }

  const sqlite = new Database(config.DATABASE_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  instance = drizzle(sqlite, { schema });
  return instance;
}

/**
 * `db.select()...` as before, resolved through getDb() on first property access.
 *
 * A proxy rather than 27 call sites changed to `getDb()`: the call sites read
 * better as `db`, and the laziness is a property of this module, not something
 * every caller should have to remember. Methods are bound to the real handle so
 * drizzle's internals never see the proxy as `this`.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real as object, prop) as unknown;
    return typeof value === 'function' ? value.bind(real) : value;
  },
});
