// ---------------------------------------------------------------------------
// Shared TypeScript types for validation-service
// ---------------------------------------------------------------------------

/** Raw metadata submitted by the client alongside the image URL. */
export interface ImageMetadata {
  date?: string;          // ISO 8601 date (with optional time)
  location?: string;
  description?: string;
  category?: string;
  tags?: string[];
  user_id?: string;
  [key: string]: unknown; // allow any additional client-provided fields
}

/**
 * Shape of the pg-boss job payload enqueued by image-intake-webhook.
 * Validated at runtime via Zod (see schemas/jobPayload.ts).
 */
export interface JobPayload {
  request_id: string;   // UUID — references validation_requests.id
  image_url: string;    // S3 URL of the image (fetched directly by the LLM)
  image_id: string;     // client-provided image identifier
  metadata: ImageMetadata;
}

/** Three-state verdict returned by the LLM. */
export type Verdict = 'valid' | 'invalid' | 'needs_review';

/**
 * Structured result produced by the LLM, after Zod validation.
 * Maps 1-to-1 to the validation_results DB table.
 */
export interface LLMResult {
  verdict: Verdict;
  confidence_score: number;   // 0.00 – 1.00
  reasoning: string;
  has_discrepancies: boolean;
  flagged_issues: string[];
}

/** Row written to validation_results on successful processing. */
export interface ValidationResult extends LLMResult {
  id: string;           // UUID — primary key
  request_id: string;   // FK → validation_requests.id
  validated_at: Date;
}

/** Possible values for validation_requests.status. */
export type RequestStatus = 'queued' | 'processing' | 'completed' | 'failed';

/** Audit log action strings. */
export type AuditAction = 'created' | 'updated' | 'failed';
