# Tech Spec: validation-service

**Component**: Validation Service (Job Worker + LLM Analysis Service + Result Processor)  
**Status**: Draft — pending review  
**Author**: ImageAnalizer team  
**Date**: 2026-04-28  
**Source of truth**: [ARCHITECTURE.md](../ARCHITECTURE.md)

---

## 1. Purpose

`validation-service` is the async processing core of ImageAnalizer. It picks up validation jobs from the pg-boss queue, calls the Claude LLM API with the image URL, metadata, and a hardcoded set of validation rules, parses the structured response, and persists the result to the database.

It does **not** accept incoming HTTP requests from clients — that is the responsibility of the upstream `image-intake-webhook`. It does **not** serve a dashboard API — that is the responsibility of the Dashboard Backend.

---

## 2. Responsibilities (In Scope)

| # | Responsibility | Notes |
|---|---------------|-------|
| 1 | Connect to pg-boss and subscribe to the `image-validation` queue | Single named queue |
| 2 | Dequeue jobs and update request status to `processing` | Atomic with job activation |
| 3 | Build the LLM prompt | System prompt = validation rules; user message = image URL + metadata |
| 4 | Call the Claude API with the image URL and metadata | Vision call — Claude fetches the image from the URL |
| 5 | Parse the structured LLM response | Validate presence of `verdict`, `confidence_score`, `reasoning` |
| 6 | INSERT row into `validation_results` | Fully populated — no nullable result columns |
| 7 | UPDATE `validation_requests.status` → `completed` | In the same DB transaction as the INSERT |
| 8 | On processing failure: UPDATE status → `failed`, INSERT audit log | Triggers pg-boss retry |
| 9 | Let pg-boss handle retries and DLQ | Exponential backoff: 3 attempts, 5s / 30s / 2m |
| 10 | Write audit log entries throughout the lifecycle | `processing`, `completed`, `failed` actions |
| 11 | Expose a health check endpoint | `GET /health` — confirms worker is running and DB is reachable |
| 12 | Environment-based configuration | DB URL, Claude API key, concurrency, etc. via env vars |

---

## 3. Out of Scope

| Item | Reason |
|------|--------|
| Accepting inbound HTTP validation requests | Handled by `image-intake-webhook`. |
| Image storage or downloading | Images are client-owned in S3. The LLM receives the URL and fetches the image directly. |
| Serving dashboard read APIs | Handled by Dashboard Backend. |
| Authentication / API key enforcement | Known gap in ARCHITECTURE.md — out of scope for demo. |
| Outbound webhook callbacks (OAD-1) | `callback_url` is stored in the DB but no POST is made yet. Tracked as OAD-1. |
| Validation rule management UI / DB-backed rules | Rules are hardcoded in the system prompt for the demo. |
| pg-boss infrastructure setup | pg-boss auto-creates its `pgboss` schema on first startup. No extra setup needed. |

---

## 4. Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js (LTS) | Matches `image-intake-webhook`; shared tooling and deployment story. |
| Language | TypeScript | Type safety on job payloads, LLM responses, and DB models. |
| HTTP Framework | Express (minimal) | Health check endpoint only — keeps the worker observable without adding overhead. |
| Queue | pg-boss | Same instance used by `image-intake-webhook`; subscribes to the `image-validation` queue. |
| Database Client | `pg` (node-postgres) | Consistent with `image-intake-webhook`; no ORM for demo scope. |
| LLM Client | `@anthropic-ai/sdk` | Official Anthropic SDK; handles auth, retries, and streaming. |
| Schema Validation | Zod | Validates the LLM JSON response before persisting. |
| Config | `dotenv` | Load env vars from `.env` in development. |
| Testing | `vitest` | Unit tests for prompt builder, response parser, and result processor. |

---

## 5. Job Contract

The validation-service consumes jobs enqueued by `image-intake-webhook` from the `image-validation` pg-boss queue. The expected job payload shape is:

```json
{
  "request_id": "UUID — references validation_requests.id",
  "image_url": "https://... — S3 URL of the image to validate",
  "image_id": "string — client-provided image identifier",
  "metadata": {
    "date": "ISO 8601 date string",
    "location": "string (optional)",
    "description": "string (optional)",
    "category": "string (optional)",
    "tags": ["string (optional array)"],
    "user_id": "string (optional)",
    "...": "any additional fields submitted by the client"
  }
}
```

**pg-boss worker options** (owned by this service):

| Option | Value | Rationale |
|--------|-------|-----------|
| `teamSize` | 5 | Max concurrent jobs per worker instance |
| `retryLimit` | 3 | Three attempts before DLQ |
| `retryDelay` | 5 | Seconds before first retry |
| `retryBackoff` | true | Exponential: 5s → 30s → 2m |
| `expireInSeconds` | 300 | Job expires after 5 min if stuck |

---

## 6. Health Check Endpoint

### `GET /health`

Confirms the worker process is alive, connected to the database, and the pg-boss worker is active. Used by uptime monitors and orchestrators (e.g., Docker health check, Kubernetes liveness probe).

**Success response** — `200 OK`:

```json
{
  "status": "ok",
  "db": "ok",
  "worker": "active"
}
```

If the DB is unreachable or the worker has stopped, the corresponding field is `"error"` and the HTTP status is `503`.

---

## 7. LLM Integration

### 7.1 Prompt Design

The LLM is called once per job. The prompt has two parts:

**System prompt** — contains the finalized validation rules (hardcoded for the demo):

```
You are an image validation assistant. Your task is to analyze a photo and its associated metadata,
then decide whether the photo is valid according to the following rules:

VALIDATION RULES:
1. SUBJECT — The image must show the exterior door of a house or building as its primary subject.
   A door must be clearly identifiable and the main focus of the photo. Interiors, windows,
   facades without a door, or unrelated subjects are not valid.

2. LIGHTING CONSISTENCY — The lighting in the image must be consistent with the time of day
   indicated by metadata.date (which includes the time when provided). For example:
   - A photo timestamped at night must show darkness or artificial lighting, not bright daylight.
   - A photo timestamped at midday must not show a dark or night-like scene.
   If no time is provided in metadata.date, this rule is not applicable and should not be flagged.

3. NO WATERMARKS — The image must not contain any visible watermarks, overlaid logos, copyright
   marks, or promotional text of any kind.

VERDICT LOGIC:
- Return "valid"        if ALL applicable rules clearly pass.
- Return "invalid"      if ANY applicable rule clearly fails.
- Return "needs_review" if you are uncertain about any rule (e.g. ambiguous lighting, partially
  visible watermark, or a door that may or may not be exterior). Do not guess — flag it for a human.

Respond ONLY with a valid JSON object in the following exact format — no markdown, no extra text:
{
  "verdict": "valid" | "invalid" | "needs_review",
  "confidence_score": <number between 0.00 and 1.00>,
  "reasoning": "<concise explanation covering each rule and your overall verdict>",
  "has_discrepancies": true | false,
  "flagged_issues": ["<one entry per failed or uncertain rule, empty array if none>"]
}
```

**User message** — contains the image URL and metadata, formatted for Claude's vision API:

```
Image URL: <image_url>

Submitted metadata:
<metadata as formatted JSON>
```

> **Image delivery**: Claude is called with the image URL directly (using `image.source.type = "url"`). Claude fetches the image from the client's S3 URL — `validation-service` never downloads or buffers the image file itself.

### 7.2 Claude API Call

```typescript
const response = await anthropic.messages.create({
  model: "claude-opus-4-5",          // configurable via env var
  max_tokens: 1024,
  system: SYSTEM_PROMPT,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "url",
            url: imageUrl,
          },
        },
        {
          type: "text",
          text: `Submitted metadata:\n${JSON.stringify(metadata, null, 2)}`,
        },
      ],
    },
  ],
});
```

### 7.3 Response Parsing

The raw LLM text response is parsed and validated against a Zod schema before any database write:

```typescript
const LLMResultSchema = z.object({
  verdict: z.enum(['valid', 'invalid', 'needs_review']),
  confidence_score: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  has_discrepancies: z.boolean(),
  flagged_issues: z.array(z.string()),
});
```

> **Three-state verdict** (resolved Q4): The LLM itself decides when it is uncertain and returns `"needs_review"` rather than forcing a binary answer. This avoids silent misclassifications on ambiguous images. The `verdict` field replaces the original `overall_valid: boolean` throughout the data model — see Section 8.

If the LLM response cannot be parsed or fails schema validation, the job is treated as failed (thrown error triggers pg-boss retry).

---

## 8. Data Written

### 8.1 On Job Activation (status transition)

```
UPDATE validation_requests
SET    status = 'processing'
WHERE  id = <request_id>
```

Audit log INSERT:
```
action      → 'updated'
entity_type → 'validation_request'
entity_id   → <request_id>
change_data → { from: 'queued', to: 'processing' }
user_id     → metadata.user_id (if present), else null
```

### 8.2 On Successful Completion

**Transaction** (both writes are atomic):

```
INSERT INTO validation_results (
  id, request_id, verdict, confidence_score,
  overall_reasoning, has_discrepancies, flagged_issues, validated_at
) VALUES (
  gen_random_uuid(), <request_id>, <verdict>, <confidence_score>,
  <reasoning>, <has_discrepancies>, <flagged_issues JSON>, NOW()
)

UPDATE validation_requests
SET    status = 'completed'
WHERE  id = <request_id>
```

> `verdict` is stored as a PostgreSQL `VARCHAR` (or `ENUM`) with values `'valid'`, `'invalid'`, `'needs_review'`. This replaces the `overall_valid BOOLEAN` column defined in the base ARCHITECTURE.md schema — **the init SQL script must be updated accordingly** (see Section 12).

Audit log INSERT:
```
action      → 'updated'
entity_type → 'validation_request'
entity_id   → <request_id>
change_data → { from: 'processing', to: 'completed', verdict: <verdict> }
```

### 8.3 On Failure (LLM error, parse error, DB error)

```
UPDATE validation_requests
SET    status = 'failed'
WHERE  id = <request_id>
```

Audit log INSERT:
```
action      → 'failed'
entity_type → 'validation_request'
entity_id   → <request_id>
change_data → { error: '<error message>', attempt: <attempt number> }
```

The job handler re-throws the error so pg-boss can schedule the next retry attempt or move the job to the DLQ after `retryLimit` is exhausted.

---

## 9. Processing Flow

```
pg-boss delivers job
        │
        ▼
Job Worker receives payload
        │
        ├── Validate payload shape (Zod)
        │   └── on failure → throw (pg-boss retries)
        │
        ├── UPDATE validation_requests status = 'processing'
        │   + INSERT audit_log
        │
        ▼
LLM Analysis Service
        │
        ├── Build system prompt (hardcoded rules)
        ├── Build user message (image URL + metadata)
        ├── Call Claude API (vision + text)
        │   └── on error → throw (pg-boss retries)
        │
        ▼
Result Processor
        │
        ├── Parse LLM response text → JSON
        ├── Validate against LLMResultSchema (Zod)
        │   └── on parse/validation failure → throw (pg-boss retries)
        │
        ├── BEGIN TRANSACTION
        │   ├── INSERT validation_results
        │   └── UPDATE validation_requests status = 'completed'
        │   COMMIT
        │   └── on DB error → ROLLBACK, throw (pg-boss retries)
        │
        └── INSERT audit_log (completed)
```

---

## 10. Project Structure

```
validation-service/
├── src/
│   ├── main.ts                    — Entry point: starts pg-boss worker + health HTTP server
│   ├── config.ts                  — Env var loading and validation (Zod)
│   ├── worker/
│   │   └── imageValidationWorker.ts   — pg-boss job handler; orchestrates the full flow
│   ├── services/
│   │   ├── db.ts                  — PostgreSQL client + query helpers + transaction wrapper
│   │   ├── queue.ts               — pg-boss client wrapper (connect, subscribe, stop)
│   │   ├── llm.ts                 — Claude API client wrapper (buildPrompt, callLLM)
│   │   └── resultProcessor.ts     — Parses LLM response, validates schema, writes to DB
│   ├── models/
│   │   └── types.ts               — Shared TypeScript types (JobPayload, ValidationResult, etc.)
│   ├── schemas/
│   │   ├── jobPayload.ts          — Zod schema for incoming pg-boss job payload
│   │   └── llmResult.ts           — Zod schema for LLM JSON response
│   └── routes/
│       └── health.ts              — GET /health handler
├── tests/
│   ├── llm.test.ts                — Unit tests: prompt builder, LLM mock responses
│   ├── resultProcessor.test.ts    — Unit tests: parse, validate, and DB write logic
│   └── worker.test.ts             — Integration tests: end-to-end job processing (mocked LLM + DB)
├── .env.example                   — Template for required env vars
├── package.json
├── tsconfig.json
├── docker-compose.yml             — Postgres only (shared schema with image-intake-webhook)
└── TECH-SPEC.md                   — This document
```

---

## 11. Environment Variables

```
PORT=3001                          # Health check HTTP port (different from intake webhook)
DATABASE_URL=postgresql://user:password@localhost:5432/imageanalizer
ANTHROPIC_API_KEY=sk-ant-...       # Claude API key
CLAUDE_MODEL=claude-sonnet-4-5     # LLM model string (resolved: Q1)
WORKER_CONCURRENCY=5               # Max concurrent jobs (pg-boss teamSize)
RETRY_LIMIT=3                      # Max job attempts before DLQ
RETRY_DELAY_SECONDS=5              # Initial retry delay (exponential backoff)
```

No Redis URL needed — pg-boss uses the same `DATABASE_URL`.

---

## 12. Local Development Setup

The `docker-compose.yml` shares the same PostgreSQL instance as `image-intake-webhook` (or can point at it via `DATABASE_URL`). The database schema (`validation_requests`, `validation_results`, `audit_logs`) is applied by the intake webhook's init SQL script — no separate migration step needed in this service.

**To run locally**:
1. Ensure PostgreSQL is running (via `image-intake-webhook/docker-compose.yml` or a shared compose file).
2. Copy `.env.example` → `.env` and fill in `DATABASE_URL` and `ANTHROPIC_API_KEY`.
3. `npm install && npm run dev` — starts the worker and health check server.

The worker will begin polling the `image-validation` pg-boss queue immediately.

---

## 13. Non-Goals & Deferred Decisions

- **Auth**: No authentication on the health endpoint. Acceptable for local demo.
- **Outbound webhook (OAD-1)**: Worker does not POST to `callback_url` after completion. This is deferred until the OAD-1 strategy is resolved.
- **Structured logging**: `console.log` is acceptable for demo. A logging library (`pino`) and tracing should be added before production.
- **Metrics / queue depth monitoring**: pg-boss exposes queue metrics via SQL — a monitoring integration (Prometheus, Datadog) is a future consideration.
- **Schema migrations**: The DB schema is applied via a plain SQL init script. Adopt a migration tool before production.
- **Multi-tenant rule sets**: Validation rules are hardcoded in the system prompt. A DB-backed `validation_rules` table with versioning is the production path (see ARCHITECTURE.md Future Considerations).

---

## 14. Open Questions

| # | Question | Owner | Status |
|---|----------|-------|--------|
| Q1 | Which Claude model should be used? | Product / Eng | ✅ Resolved — `claude-sonnet-4-5`. Best balance of speed, cost, and vision quality for this workload. |
| Q2 | What are the exact validation rules for the demo? | Product | ✅ Resolved — see Section 7.1 for the finalized system prompt. |
| Q3 | Should the worker run as a separate process/container from `image-intake-webhook`, or co-located? | Eng | ✅ Resolved — co-located for the demo. Both services share one container/process. Note: split into separate containers before any production or scaled deployment. |
| Q4 | How should confidence score affect the final verdict? | Product | ✅ Resolved — three-state model: the LLM returns `"valid"`, `"invalid"`, or `"needs_review"` directly. No confidence threshold override applied in code. `confidence_score` is stored for dashboard display only. The `overall_valid` boolean in ARCHITECTURE.md is superseded by the `verdict` VARCHAR column. |
| Q5 | Should `flagged_issues` be surfaced in the dashboard even when verdict is `"valid"`? | Product | ✅ Resolved — yes, always show. A valid image can still carry minor observations. The dashboard must display `flagged_issues` regardless of verdict. |
