import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

const envPath = resolve(process.cwd(), '.env');
const rootEnvPath = resolve(process.cwd(), '../../.env');
config({ path: existsSync(envPath) ? envPath : rootEnvPath });

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/rumble.db',
  },
});
