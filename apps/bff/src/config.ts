import { z } from 'zod';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),

  WAHOO_CLIENT_ID: z.string().optional().default(''),
  WAHOO_CLIENT_SECRET: z.string().optional().default(''),
  WAHOO_REDIRECT_URI: z.string().optional().default(''),
  WAHOO_WEBHOOK_TOKEN: z.string().optional().default(''),

  DATABASE_PATH: z.string().default('./data/rumble.db'),
  ENCRYPTION_KEY: z.string().length(64),
  PORT: z.coerce.number().default(3001),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  ATHLETE_TIMEZONE: z.string().default('Europe/Madrid'),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;

export const wahooEnabled =
  config.WAHOO_CLIENT_ID.length > 0 && config.WAHOO_CLIENT_SECRET.length > 0;
