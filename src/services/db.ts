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
