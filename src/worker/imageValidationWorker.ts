import PgBoss from 'pg-boss';
import { config } from '../config';
import { QUEUE_NAME } from '../services/queue';
import { JobPayloadSchema } from '../schemas/jobPayload';
import { callLLM } from '../services/llm';
import { persistResult, persistFailure } from '../services/resultProcessor';
import { insertAuditLog, getPool } from '../services/db';
import { ImageMetadata } from '../models/types';

// ---------------------------------------------------------------------------
// Job handler — pg-boss v10 delivers an array of jobs per poll
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
  // pg-boss v10 exposes attempt count via retryCount (0-indexed)
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
// Batch handler — pg-boss v10 work() handler receives Job[]
// ---------------------------------------------------------------------------

async function batchHandler(jobs: PgBoss.Job<unknown>[]): Promise<void> {
  await Promise.all(jobs.map((job) => handleImageValidationJob(job)));
}

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------

/**
 * Subscribe the batch handler to the image-validation queue.
 * pg-boss v10: WorkOptions supports batchSize (controls fetch batch size)
 * and pollingIntervalSeconds. Retry options (retryLimit, retryDelay,
 * retryBackoff) are set on the job at send time by image-intake-webhook.
 */
export async function startWorker(boss: PgBoss): Promise<void> {
  await boss.work<unknown>(
    QUEUE_NAME,
    {
      batchSize: config.WORKER_CONCURRENCY,
    },
    batchHandler
  );

  console.log(
    `[worker] Subscribed to queue="${QUEUE_NAME}" batchSize=${config.WORKER_CONCURRENCY}`
  );
}
