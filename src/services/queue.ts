import PgBoss from 'pg-boss';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Queue name constant — must match what image-intake-webhook enqueues to
// ---------------------------------------------------------------------------
export const QUEUE_NAME = 'image-validation';

// ---------------------------------------------------------------------------
// pg-boss singleton
// ---------------------------------------------------------------------------

let boss: PgBoss | null = null;

/**
 * Create (or return the existing) pg-boss instance and start it.
 * pg-boss auto-creates the `pgboss` schema in PostgreSQL on first run.
 */
export async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss({
      connectionString: config.DATABASE_URL,
      // Reduce pg-boss maintenance noise in dev
      deleteAfterDays: 7,
      archiveCompletedAfterSeconds: 60 * 60 * 24, // 1 day
    });

    boss.on('error', (err) => {
      console.error('[queue] pg-boss error:', err);
    });

    await boss.start();
    console.log('[queue] pg-boss started');
  }
  return boss;
}

/**
 * Gracefully stop pg-boss.
 * Should be called on process shutdown to drain in-flight jobs.
 */
export async function stopBoss(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
    console.log('[queue] pg-boss stopped');
  }
}
