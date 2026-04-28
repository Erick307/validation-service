import { LLMResult, ImageMetadata } from '../models/types';
import {
  withTransaction,
  updateRequestStatus,
  insertValidationResult,
  insertAuditLog,
} from './db';

// ---------------------------------------------------------------------------
// Result Processor
// ---------------------------------------------------------------------------

/**
 * Persist a successful validation result.
 *
 * Atomically:
 *   1. INSERT into validation_results
 *   2. UPDATE validation_requests.status → 'completed'
 *
 * Then (outside the transaction) inserts an audit log entry.
 *
 * Throws on any DB error — caller (job worker) will trigger a pg-boss retry.
 */
export async function persistResult(
  requestId: string,
  result: LLMResult,
  metadata: ImageMetadata
): Promise<void> {
  await withTransaction(async (client) => {
    await insertValidationResult(client, requestId, result);
    await updateRequestStatus(client, requestId, 'completed');
  });

  // Audit log is written outside the main transaction so it's not lost on
  // a transient rollback in a future retry path.
  await insertAuditLog(requestId, 'updated', {
    from: 'processing',
    to: 'completed',
    verdict: result.verdict,
  }, metadata.user_id as string | undefined ?? null);

  console.log(
    `[resultProcessor] request=${requestId} verdict=${result.verdict} confidence=${result.confidence_score}`
  );
}

/**
 * Record a processing failure.
 *
 * Updates the request status to 'failed' and inserts an audit log entry.
 * pg-boss will schedule retries independently — this is purely for DB state
 * and audit trail visibility.
 *
 * Does NOT throw — we want the failure record written even if the worker
 * is about to re-throw so pg-boss can retry.
 */
export async function persistFailure(
  requestId: string,
  error: unknown,
  attempt: number,
  userId?: string | null
): Promise<void> {
  const errorMessage =
    error instanceof Error ? error.message : String(error);

  try {
    // Status update uses a direct pool query (not a transaction) to avoid
    // compounding a DB error on top of an already-failed job.
    const { getPool } = await import('./db');
    await getPool().query(
      `UPDATE validation_requests SET status = 'failed' WHERE id = $1`,
      [requestId]
    );
  } catch (dbErr) {
    console.error(
      `[resultProcessor] Failed to update status to failed for request=${requestId}:`,
      dbErr
    );
  }

  try {
    await insertAuditLog(
      requestId,
      'failed',
      { error: errorMessage, attempt },
      userId ?? null
    );
  } catch (auditErr) {
    console.error(
      `[resultProcessor] Failed to write failure audit log for request=${requestId}:`,
      auditErr
    );
  }

  console.error(
    `[resultProcessor] request=${requestId} attempt=${attempt} error="${errorMessage}"`
  );
}
