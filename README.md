# validation-service

Async Validation Worker for **ImageAnalizer**.

Picks up image validation jobs from the pg-boss queue, calls the Claude LLM API with the image URL and metadata, parses the structured response, and persists the result to PostgreSQL. It does **not** accept inbound HTTP requests from clients — that is handled by the upstream `image-intake-webhook`.

---

## How it works

1. `image-intake-webhook` enqueues a job into the `image-validation` pg-boss queue whenever a new validation request arrives.
2. The worker dequeues the job, updates the request status to `processing`, and calls the Claude API with the image URL and metadata.
3. The LLM analyzes the image against the hardcoded validation rules and returns a structured JSON verdict.
4. The Result Processor validates the response, persists it to `validation_results`, and marks the request as `completed`.
5. On any failure, the job is re-thrown so pg-boss can retry with exponential backoff (up to 3 attempts, then DLQ).

---

## Validation rules

The LLM is instructed to evaluate every image against three rules:

| # | Rule | Description |
|---|------|-------------|
| 1 | **Subject** | The image must show the exterior door of a house or building as its primary subject. |
| 2 | **Lighting consistency** | Lighting must match the time of day in `metadata.date`. Skipped if no time is provided. |
| 3 | **No watermarks** | No visible watermarks, overlaid logos, copyright marks, or promotional text. |

**Verdicts**: `valid` · `invalid` · `needs_review` (returned when the model is uncertain about any rule).

See `TECH-SPEC.md` Section 7.1 for the full system prompt.

---

## Endpoints

This service exposes a single HTTP endpoint for observability only:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Worker health check (DB + worker status) |

### GET /health

**Success — `200 OK`:**
```json
{
  "status": "ok",
  "db": "ok",
  "worker": "active"
}
```

If the DB is unreachable or the worker has stopped, the affected field is `"error"` and the status is `503`.

---

## Local development

### Prerequisites

- Node.js LTS
- Docker + Docker Compose
- A running PostgreSQL instance (shared with `image-intake-webhook`, or via this service's own `docker-compose.yml`)
- An Anthropic API key

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in DATABASE_URL and ANTHROPIC_API_KEY

# 3. Start PostgreSQL (if not already running via image-intake-webhook)
docker-compose up -d

# 4. Start the worker (with auto-reload)
npm run dev
```

The worker starts polling the `image-validation` queue immediately. The health check server starts on `http://localhost:3001` by default.

> The database schema is applied by `image-intake-webhook`'s init SQL script. Start that service first (or run its `docker-compose up`) before running this one.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Health check HTTP port |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude model string |
| `WORKER_CONCURRENCY` | `5` | Max concurrent jobs (pg-boss teamSize) |
| `RETRY_LIMIT` | `3` | Max job attempts before DLQ |
| `RETRY_DELAY_SECONDS` | `5` | Initial retry delay (exponential backoff) |

---

## Running tests

```bash
npm test
```

Tests use [vitest](https://vitest.dev/). LLM and DB calls are mocked — no live database or API key required.

---

## Project structure

```
validation-service/
├── src/
│   ├── main.ts                        — Entry point: starts worker + health server
│   ├── config.ts                      — Env var loading (Zod)
│   ├── worker/
│   │   └── imageValidationWorker.ts   — pg-boss job handler; orchestrates the full flow
│   ├── services/
│   │   ├── db.ts                      — PostgreSQL client + query helpers
│   │   ├── queue.ts                   — pg-boss client wrapper
│   │   ├── llm.ts                     — Claude API client (prompt builder + LLM call)
│   │   └── resultProcessor.ts         — Parses LLM response, validates schema, writes to DB
│   ├── models/
│   │   └── types.ts                   — Shared TypeScript types
│   ├── schemas/
│   │   ├── jobPayload.ts              — Zod schema for pg-boss job payload
│   │   └── llmResult.ts               — Zod schema for LLM JSON response
│   └── routes/
│       └── health.ts                  — GET /health handler
├── tests/
│   ├── llm.test.ts                    — Prompt builder + LLM response parser
│   ├── resultProcessor.test.ts        — Parse, validate, and DB write logic
│   └── worker.test.ts                 — End-to-end job processing (mocked LLM + DB)
├── docker-compose.yml                 — PostgreSQL only
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Infrastructure

This service uses **PostgreSQL as the only infrastructure dependency** — pg-boss creates and manages its own `pgboss` schema inside the same database. No Redis required.

**pg-boss retry configuration:**

| Option | Value |
|--------|-------|
| Max attempts | 3 |
| Initial retry delay | 5s |
| Backoff | Exponential (5s → 30s → 2m) |
| Job expiry | 5 minutes |
| Dead-letter queue | Enabled after max attempts |

---

## Notes

- Images are never downloaded by this service — the Claude API receives the S3 URL and fetches the image directly.
- `callback_url` is stored in the DB but no outbound POST is made yet (tracked as OAD-1 in `ARCHITECTURE.md`).
- Authentication is intentionally out of scope for the demo. See `ARCHITECTURE.md` Known Gaps.
- Validation rules are hardcoded in the system prompt. A DB-backed rules table is the production path — see `ARCHITECTURE.md` Future Considerations.
