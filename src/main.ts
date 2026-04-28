import express from 'express';
import { config } from './config';
import { getBoss, stopBoss } from './services/queue';
import { closePool } from './services/db';
import { startWorker } from './worker/imageValidationWorker';
import { createHealthRouter } from './routes/health';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let workerActive = false;

async function main(): Promise<void> {
  console.log('[main] Starting validation-service...');

  // ── pg-boss + worker ──────────────────────────────────────────────────────
  const boss = await getBoss();
  await startWorker(boss);
  workerActive = true;

  // ── Express health check server ───────────────────────────────────────────
  const app = express();
  app.use(createHealthRouter(() => workerActive));

  const server = app.listen(config.PORT, () => {
    console.log(`[main] Health check listening on port ${config.PORT}`);
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[main] Received ${signal} — shutting down gracefully...`);
    workerActive = false;

    server.close(async () => {
      console.log('[main] HTTP server closed');
      await stopBoss();
      await closePool();
      console.log('[main] Shutdown complete');
      process.exit(0);
    });

    // Force-exit after 15 s if graceful drain takes too long
    setTimeout(() => {
      console.error('[main] Shutdown timeout — forcing exit');
      process.exit(1);
    }, 15_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[main] Fatal startup error:', err);
  process.exit(1);
});
