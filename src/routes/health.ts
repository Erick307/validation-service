import { Router, Request, Response } from 'express';
import { checkDbHealth } from '../services/db';

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

/**
 * Health check endpoint.
 *
 * Returns 200 when both the DB and the pg-boss worker are operational.
 * Returns 503 if either is unhealthy.
 *
 * Used by Docker health checks, Kubernetes liveness probes, and uptime monitors.
 */
export function createHealthRouter(isWorkerActive: () => boolean): Router {
  const router = Router();

  router.get('/health', async (_req: Request, res: Response) => {
    const dbOk = await checkDbHealth();
    const workerOk = isWorkerActive();

    const body = {
      status: dbOk && workerOk ? 'ok' : 'error',
      db: dbOk ? 'ok' : 'error',
      worker: workerOk ? 'active' : 'error',
    };

    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });

  return router;
}
