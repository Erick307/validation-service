import PgBoss from 'pg-boss';
import { config } from '../config';
import { QUEUE_NAME } from '../services/queue';
import { JobPayloadSchema } from '../schemas/jobPayload';
import { callLLM } from '../services/llm';
import { persistResult, persistFailure } from '../services/resultProcessor';
import { withTransaction, updateRequestStatus, insertAuditLog, getPool } from '../services/db';
import { ImageMetadata } from '../models/types';

// ---------------------------------------------------------------------------
// Job handler
// ---------------------------------------------------------------------------

/**
 * Process a single image-validation job delivered by pg-boss.
 *
 * Flow (mirrors TECH-SPEC section 9):
 *   1. Validate job payload shape
 *   2. UPDATE status → 'processing' + audit log
 *   3. Call LLM (Claude vision)
 *   4. Persist result (INSERT validation_results + UPDATE status → 'completed')
 *   5. On any error → persist failure + re-throw so pg-boss can retry
 */
export async function handleImageValidationJob(
  job: PgBoss.Job<unknown>
): Promise<void> {
  // ── Step 1: Validate payload ──────────────────────────────────────────────
  const payloadResult = JobPayloadSchema.safeParse(job.data);
  if (!payloadResult.success) {
    // Malformed payload — do NOT retry (no request_id to update).
    // Log and return without throwing so pg-boss completes (not fails) the job.
    console.error(
      '[worker] Malformed job payload — discarding without retry:',
      payloadResult.error.flatten().fieldErrors
    );
    return;
  }

  const { request_id, image_url, metadata } = payloadResult.data;
  const typedMetadata = metadata as ImageMetadata;
  const userId = typedMetadata.user_id as string | undefined ?? null;
  // pg-boss exposes the current attempt count via job.retryCount (0-indexed)
  const attempt = (job as unknown as { retryCount?: number }).retryCount ?? 0;

  try {
    // ── Step 2: Mark as processing ──────────────────────────────────────────
    await getPool().query(
      `UPDATE validation_requests SET status = 'processing' WHERE id = $1`,
      [request_id]
    );
    await insertAuditLog(
      request_id,
      'updated',
      { from: 'queued', to: 'processing' },
      userId
    );

    console.log(`[worker] Processing job ${job.id} | request=${request_id}`);

    // ── Step 3: Call LLM ────────────────────────────────────────────────────
    const llmResult = await callLLM(image_url, typedMetadata);

    // ── Step 4: Persist result ──────────────────────────────────────────────
    await persistResult(request_id, llmResult, typedMetadata);

    console.log(
      `[worker] Completed job ${job.id} | request=${request_id} | verdict=${llmResult.verdict}`
    );
  } catch (err) {
    // ── Step 5: Handle failure ──────────────────────────────────────────────
    await persistFailure(request_id, err, attempt + 1, userId);
    // Re-throw so pg-boss schedules the next retry (or moves to DLQ).
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------

/**
 * Subscribe the job handler to the image-validation queue.
 * Returns the pg-boss instance for lifecycle management.
 */
export async function startWorker(boss: PgBoss): Promise<void> {
  await boss.work<unknown>(
    QUEUE_NAME,
    {
      teamSize: config.WORKER_CONCURRENCY,
      teamConcurrency: config.WORKER_CONCURRENCY,
      retryLimit: config.RETRY_LIMIT,
      retryDelay: config.RETRY_DELAY_SECONDS,
      retryBackoff: true,
      expireInSeconds: 300,
    },
    handleImageValidationJob
  );

  console.log(
    `[worker] Subscribed to queue="${QUEUE_NAME}" concurrency=${config.WORKER_CONCURRENCY}`
  );
}
