import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  CLAUDE_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  RETRY_LIMIT: z.coerce.number().int().positive().default(3),
  RETRY_DELAY_SECONDS: z.coerce.number().int().positive().default(5),
});

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
