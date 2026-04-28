import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMResult, ImageMetadata } from '../src/models/types';

// ---------------------------------------------------------------------------
// Mock DB module before importing resultProcessor
// ---------------------------------------------------------------------------

vi.mock('../src/services/db', () => ({
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<void>) => {
    await fn({});
  }),
  updateRequestStatus: vi.fn(),
  insertValidationResult: vi.fn(),
  insertAuditLog: vi.fn(),
  getPool: vi.fn(() => ({
    query: vi.fn(),
  })),
}));

import {
  withTransaction,
  updateRequestStatus,
  insertValidationResult,
  insertAuditLog,
  getPool,
} from '../src/services/db';

import { persistResult, persistFailure } from '../src/services/resultProcessor';

// ---------------------------------------------------------------------------
// persistResult — unit tests
// ---------------------------------------------------------------------------

describe('persistResult', () => {
  const requestId = '11111111-1111-1111-1111-111111111111';
  const metadata: ImageMetadata = { user_id: 'user-99', date: '2024-06-15T12:00:00Z' };

  const validResult: LLMResult = {
    verdict: 'valid',
    confidence_score: 0.95,
    reasoning: 'All rules pass.',
    has_discrepancies: false,
    flagged_issues: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls withTransaction, insertValidationResult, and updateRequestStatus', async () => {
    await persistResult(requestId, validResult, metadata);

    expect(withTransaction).toHaveBeenCalledOnce();
    expect(insertValidationResult).toHaveBeenCalledWith(
      expect.anything(),
      requestId,
      validResult
    );
    expect(updateRequestStatus).toHaveBeenCalledWith(
      expect.anything(),
      requestId,
      'completed'
    );
  });

  it('inserts an audit log with the correct payload after committing', async () => {
    await persistResult(requestId, validResult, metadata);

    expect(insertAuditLog).toHaveBeenCalledWith(
      requestId,
      'updated',
      expect.objectContaining({ from: 'processing', to: 'completed', verdict: 'valid' }),
      'user-99'
    );
  });

  it('propagates DB errors thrown inside the transaction', async () => {
    vi.mocked(withTransaction).mockRejectedValueOnce(new Error('DB write failed'));

    await expect(persistResult(requestId, validResult, metadata)).rejects.toThrow(
      'DB write failed'
    );
  });
});

// ---------------------------------------------------------------------------
// persistFailure — unit tests
// ---------------------------------------------------------------------------

describe('persistFailure', () => {
  const requestId = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    vi.clearAllMocks();

    // getPool().query is used directly inside persistFailure
    const mockQuery = vi.fn().mockResolvedValue({});
    vi.mocked(getPool).mockReturnValue({ query: mockQuery } as unknown as ReturnType<typeof getPool>);
  });

  it('updates request status to failed via pool.query', async () => {
    await persistFailure(requestId, new Error('LLM timeout'), 2, 'user-1');

    const poolInstance = getPool();
    expect(poolInstance.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      [requestId]
    );
  });

  it('inserts an audit log entry with error and attempt number', async () => {
    const err = new Error('API 503');
    await persistFailure(requestId, err, 2, 'user-1');

    expect(insertAuditLog).toHaveBeenCalledWith(
      requestId,
      'failed',
      expect.objectContaining({ error: 'API 503', attempt: 2 }),
      'user-1'
    );
  });

  it('does NOT throw even if pool.query fails', async () => {
    const mockQuery = vi.fn().mockRejectedValue(new Error('Connection lost'));
    vi.mocked(getPool).mockReturnValue({ query: mockQuery } as unknown as ReturnType<typeof getPool>);

    // Should resolve without throwing
    await expect(
      persistFailure(requestId, new Error('original error'), 1, null)
    ).resolves.toBeUndefined();
  });

  it('handles non-Error throw values gracefully', async () => {
    await expect(
      persistFailure(requestId, 'string error', 1, null)
    ).resolves.toBeUndefined();

    expect(insertAuditLog).toHaveBeenCalledWith(
      requestId,
      'failed',
      expect.objectContaining({ error: 'string error' }),
      null
    );
  });
});
