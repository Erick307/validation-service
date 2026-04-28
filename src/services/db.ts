import { Pool, PoolClient } from 'pg';
import { config } from '../config';
import { RequestStatus, AuditAction, LLMResult } from '../models/types';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.DATABASE_URL });
    pool.on('error', (err) => {
      console.error('[db] Unexpected pool error:', err);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Ping the database — used by the health check endpoint. */
export async function checkDbHealth(): Promise<boolean> {
  try {
    const client = getPool();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

/**
 * Runs `fn` inside a single serializable transaction.
 * Commits on success, rolls back and re-throws on error.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Update validation_requests.status to the given value.
 */
export async function updateRequestStatus(
  client: PoolClient,
  requestId: string,
  status: RequestStatus
): Promise<void> {
  await client.query(
    `UPDATE validation_requests SET status = $1 WHERE id = $2`,
    [status, requestId]
  );
}

/**
 * Insert a row into validation_results.
 * Called inside a transaction together with updateRequestStatus.
 */
export async function insertValidationResult(
  client: PoolClient,
  requestId: string,
  result: LLMResult
): Promise<string> {
  const id = uuidv4();
  await client.query(
    `INSERT INTO validation_results
       (id, request_id, verdict, confidence_score, overall_reasoning,
        has_discrepancies, flagged_issues, validated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      id,
      requestId,
      result.verdict,
      result.confidence_score,
      result.reasoning,
      result.has_discrepancies,
      JSON.stringify(result.flagged_issues),
    ]
  );
  return id;
}

// ---------------------------------------------------------------------------
// Read helpers (Dashboard / Reader API)
// ---------------------------------------------------------------------------

export interface ValidationListRow {
  id: string;
  image_id: string;
  image_url: string;
  metadata: Record<string, unknown>;
  status: RequestStatus;
  user_id: string | null;
  source: string;
  created_at: Date;
  // joined from validation_results (nullable when not yet completed)
  verdict: string | null;
  confidence_score: number | null;
  overall_reasoning: string | null;
  has_discrepancies: boolean | null;
  flagged_issues: string[] | null;
  validated_at: Date | null;
}

export interface ValidationStats {
  total: number;
  valid: number;
  invalid: number;
  needs_review: number;
  queued: number;
  processing: number;
  failed: number;
}

/**
 * List validation requests with their results, supporting pagination and
 * optional status/verdict filters.
 */
export async function listValidations(opts: {
  limit: number;
  offset: number;
  status?: string;
  verdict?: string;
}): Promise<{ rows: ValidationListRow[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (opts.status) {
    conditions.push(`vr.status = $${idx++}`);
    values.push(opts.status);
  }
  if (opts.verdict) {
    conditions.push(`res.verdict = $${idx++}`);
    values.push(opts.verdict);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM validation_requests vr
     LEFT JOIN validation_results res ON res.request_id = vr.id
     ${where}`,
    values
  );

  const total = parseInt(countRes.rows[0].count, 10);

  const dataRes = await getPool().query<ValidationListRow>(
    `SELECT
       vr.id, vr.image_id, vr.image_url, vr.metadata, vr.status,
       vr.user_id, vr.source, vr.created_at,
       res.verdict, res.confidence_score, res.overall_reasoning,
       res.has_discrepancies, res.flagged_issues, res.validated_at
     FROM validation_requests vr
     LEFT JOIN validation_results res ON res.request_id = vr.id
     ${where}
     ORDER BY vr.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, opts.limit, opts.offset]
  );

  return { rows: dataRes.rows, total };
}

/**
 * Fetch a single validation request + its result by request ID.
 * Returns null if the request does not exist.
 */
export async function getValidationById(
  id: string
): Promise<ValidationListRow | null> {
  const res = await getPool().query<ValidationListRow>(
    `SELECT
       vr.id, vr.image_id, vr.image_url, vr.metadata, vr.status,
       vr.user_id, vr.source, vr.created_at,
       res.verdict, res.confidence_score, res.overall_reasoning,
       res.has_discrepancies, res.flagged_issues, res.validated_at
     FROM validation_requests vr
     LEFT JOIN validation_results res ON res.request_id = vr.id
     WHERE vr.id = $1`,
    [id]
  );
  return res.rows[0] ?? null;
}

/**
 * Fetch just the status field for a request.
 * Lightweight polling endpoint — avoids joining validation_results.
 */
export async function getValidationStatus(
  id: string
): Promise<{ status: RequestStatus } | null> {
  const res = await getPool().query<{ status: RequestStatus }>(
    `SELECT status FROM validation_requests WHERE id = $1`,
    [id]
  );
  return res.rows[0] ?? null;
}

/**
 * Aggregate counts across all validation requests and results.
 */
export async function getValidationStats(): Promise<ValidationStats> {
  const res = await getPool().query<{
    total: string;
    valid: string;
    invalid: string;
    needs_review: string;
    queued: string;
    processing: string;
    failed: string;
  }>(
    `SELECT
       COUNT(*)                                              AS total,
       COUNT(*) FILTER (WHERE res.verdict = 'valid')        AS valid,
       COUNT(*) FILTER (WHERE res.verdict = 'invalid')      AS invalid,
       COUNT(*) FILTER (WHERE res.verdict = 'needs_review') AS needs_review,
       COUNT(*) FILTER (WHERE vr.status  = 'queued')        AS queued,
       COUNT(*) FILTER (WHERE vr.status  = 'processing')    AS processing,
       COUNT(*) FILTER (WHERE vr.status  = 'failed')        AS failed
     FROM validation_requests vr
     LEFT JOIN validation_results res ON res.request_id = vr.id`
  );

  const row = res.rows[0];
  return {
    total:        parseInt(row.total,        10),
    valid:        parseInt(row.valid,         10),
    invalid:      parseInt(row.invalid,       10),
    needs_review: parseInt(row.needs_review,  10),
    queued:       parseInt(row.queued,        10),
    processing:   parseInt(row.processing,    10),
    failed:       parseInt(row.failed,        10),
  };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Insert an audit log entry. Uses a fresh pool connection (not transactional)
 * so audit logs are persisted even when the surrounding transaction rolls back.
 */
export async function insertAuditLog(
  requestId: string,
  action: AuditAction,
  changeData: Record<string, unknown>,
  userId?: string | null
): Promise<void> {
  const id = uuidv4();
  await getPool().query(
    `INSERT INTO audit_logs
       (id, action, entity_type, entity_id, change_data, user_id, created_at)
     VALUES ($1, $2, 'validation_request', $3, $4, $5, NOW())`,
    [id, action, requestId, JSON.stringify(changeData), userId ?? null]
  );
}
