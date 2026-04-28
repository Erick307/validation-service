import { describe, it, expect, vi, beforeEach } from 'vitest';
import type PgBoss from 'pg-boss';

// ---------------------------------------------------------------------------
// Mock dependencies before importing the worker
// ---------------------------------------------------------------------------

vi.mock('../src/config', () => ({
  config: {
    WORKER_CONCURRENCY: 5,
    RETRY_LIMIT: 3,
    RETRY_DELAY_SECONDS: 5,
    ANTHROPIC_API_KEY: 'test-key',
    CLAUDE_MODEL: 'claude-sonnet-4-5',
    DATABASE_URL: 'postgresql://localhost/test',
    PORT: 3001,
  },
}));

vi.mock('../src/services/llm', () => ({
  callLLM: vi.fn(),
}));

vi.mock('../src/services/resultProcessor', () => ({
  persistResult: vi.fn(),
  persistFailure: vi.fn(),
}));

vi.mock('../src/services/db', () => ({
  getPool: vi.fn(() => ({ query: vi.fn().mockResolvedValue({}) })),
  insertAuditLog: vi.fn(),
}));

import { handleImageValidationJob } from '../src/worker/imageValidationWorker';
import { callLLM } from '../src/services/llm';
import { persistResult, persistFailure } from '../src/services/resultProcessor';
import { getPool, insertAuditLog } from '../src/services/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_PAYLOAD = {
  request_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  image_url: 'https://bucket.s3.amazonaws.com/images/door.jpg',
  image_id: 'img-001',
  metadata: {
    date: '2024-06-15T12:00:00Z',
    user_id: 'user-42',
  },
};

const VALID_LLM_RESULT = {
  verdict: 'valid' as const,
  confidence_score: 0.97,
  reasoning: 'Clear exterior door, noon lighting, no watermarks.',
  has_discrepancies: false,
  flagged_issues: [],
};

function makeJob(data: unknown, retryCount = 0): PgBoss.Job<unknown> {
  return {
    id: 'job-test-001',
    name: 'image-validation',
    data,
    retryCount,
  } as unknown as PgBoss.Job<unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleImageValidationJob — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockQuery = vi.fn().mockResolvedValue({});
    vi.mocked(getPool).mockReturnValue({ query: mockQuery } as unknown as ReturnType<typeof getPool>);
    vi.mocked(callLLM).mockResolvedValue(VALID_LLM_RESULT);
    vi.mocked(persistResult).mockResolvedValue(undefined);
  });

  it('calls callLLM with image_url and metadata from the job payload', async () => {
    await handleImageValidationJob(makeJob(VALID_PAYLOAD));

    expect(callLLM).toHaveBeenCalledWith(
      VALID_PAYLOAD.image_url,
      VALID_PAYLOAD.metadata
    );
  });

  it('calls persistResult with the LLM result', async () => {
    await handleImageValidationJob(makeJob(VALID_PAYLOAD));

    expect(persistResult).toHaveBeenCalledWith(
      VALID_PAYLOAD.request_id,
      VALID_LLM_RESULT,
      VALID_PAYLOAD.metadata
    );
  });

  it('updates request status to processing before calling LLM', async () => {
    const mockQuery = vi.fn().mockResolvedValue({});
    vi.mocked(getPool).mockReturnValue({ query: mockQuery } as unknown as ReturnType<typeof getPool>);

    await handleImageValidationJob(makeJob(VALID_PAYLOAD));

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'processing'"),
      [VALID_PAYLOAD.request_id]
    );
  });

  it('inserts an audit log for the processing transition', async () => {
    await handleImageValidationJob(makeJob(VALID_PAYLOAD));

    expect(insertAuditLog).toHaveBeenCalledWith(
      VALID_PAYLOAD.request_id,
      'updated',
      expect.objectContaining({ from: 'queued', to: 'processing' }),
      'user-42'
    );
  });

  it('does NOT call persistFailure on success', async () => {
    await handleImageValidationJob(makeJob(VALID_PAYLOAD));
    expect(persistFailure).not.toHaveBeenCalled();
  });
});

describe('handleImageValidationJob — LLM failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockQuery = vi.fn().mockResolvedValue({});
    vi.mocked(getPool).mockReturnValue({ query: mockQuery } as unknown as ReturnType<typeof getPool>);
    vi.mocked(callLLM).mockRejectedValue(new Error('LLM API 503'));
    vi.mocked(persistFailure).mockResolvedValue(undefined);
  });

  it('calls persistFailure when the LLM throws', async () => {
    await expect(handleImageValidationJob(makeJob(VALID_PAYLOAD, 1))).rejects.toThrow(
      'LLM API 503'
    );

    expect(persistFailure).toHaveBeenCalledWith(
      VALID_PAYLOAD.request_id,
      expect.any(Error),
      2, // attempt = retryCount (1) + 1
      'user-42'
    );
  });

  it('re-throws the error so pg-boss can retry', async () => {
    await expect(handleImageValidationJob(makeJob(VALID_PAYLOAD))).rejects.toThrow(
      'LLM API 503'
    );
  });
});

describe('handleImageValidationJob — malformed payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns without throwing when payload is missing request_id', async () => {
    const badPayload = { image_url: 'https://example.com/img.jpg', image_id: 'x', metadata: {} };
    // Should resolve (not throw) — malformed jobs are discarded, not retried
    await expect(handleImageValidationJob(makeJob(badPayload))).resolves.toBeUndefined();
    expect(callLLM).not.toHaveBeenCalled();
    expect(persistFailure).not.toHaveBeenCalled();
  });

  it('returns without throwing when payload is null', async () => {
    await expect(handleImageValidationJob(makeJob(null))).resolves.toBeUndefined();
  });

  it('returns without throwing when image_url is not a valid URL', async () => {
    const badPayload = { ...VALID_PAYLOAD, image_url: 'not-a-url' };
    await expect(handleImageValidationJob(makeJob(badPayload))).resolves.toBeUndefined();
    expect(callLLM).not.toHaveBeenCalled();
  });
});
