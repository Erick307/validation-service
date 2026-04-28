import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before any module that imports it is loaded.
// llm.ts → config.ts would call process.exit(1) in a test environment
// where DATABASE_URL / ANTHROPIC_API_KEY are not set.
vi.mock('../src/config', () => ({
  config: {
    ANTHROPIC_API_KEY: 'test-key',
    CLAUDE_MODEL: 'claude-sonnet-4-5',
    DATABASE_URL: 'postgresql://localhost/test',
    PORT: 3001,
    WORKER_CONCURRENCY: 5,
    RETRY_LIMIT: 3,
    RETRY_DELAY_SECONDS: 5,
  },
}));

import { parseLLMResponse, buildUserMessage, SYSTEM_PROMPT } from '../src/services/llm';

// ---------------------------------------------------------------------------
// parseLLMResponse — unit tests
// ---------------------------------------------------------------------------

describe('parseLLMResponse', () => {
  it('parses a valid "valid" verdict response', () => {
    const raw = JSON.stringify({
      verdict: 'valid',
      confidence_score: 0.95,
      reasoning: 'Image shows a clear exterior door. Lighting matches the noon timestamp. No watermarks.',
      has_discrepancies: false,
      flagged_issues: [],
    });
    const result = parseLLMResponse(raw);
    expect(result.verdict).toBe('valid');
    expect(result.confidence_score).toBe(0.95);
    expect(result.has_discrepancies).toBe(false);
    expect(result.flagged_issues).toHaveLength(0);
  });

  it('parses a valid "invalid" verdict response', () => {
    const raw = JSON.stringify({
      verdict: 'invalid',
      confidence_score: 0.99,
      reasoning: 'The image shows an interior room, not an exterior door.',
      has_discrepancies: true,
      flagged_issues: ['SUBJECT: image does not show an exterior door'],
    });
    const result = parseLLMResponse(raw);
    expect(result.verdict).toBe('invalid');
    expect(result.flagged_issues).toHaveLength(1);
  });

  it('parses a valid "needs_review" verdict response', () => {
    const raw = JSON.stringify({
      verdict: 'needs_review',
      confidence_score: 0.5,
      reasoning: 'The door is partially visible but it is unclear if it is exterior.',
      has_discrepancies: true,
      flagged_issues: ['SUBJECT: door exterior status ambiguous'],
    });
    const result = parseLLMResponse(raw);
    expect(result.verdict).toBe('needs_review');
  });

  it('throws on non-JSON response', () => {
    expect(() => parseLLMResponse('Not valid JSON at all')).toThrow(
      /not valid JSON/i
    );
  });

  it('throws when verdict is an unexpected value', () => {
    const raw = JSON.stringify({
      verdict: 'maybe',
      confidence_score: 0.5,
      reasoning: 'Unsupported verdict value.',
      has_discrepancies: false,
      flagged_issues: [],
    });
    expect(() => parseLLMResponse(raw)).toThrow(/schema validation/i);
  });

  it('throws when confidence_score is out of range', () => {
    const raw = JSON.stringify({
      verdict: 'valid',
      confidence_score: 1.5, // invalid
      reasoning: 'Score too high.',
      has_discrepancies: false,
      flagged_issues: [],
    });
    expect(() => parseLLMResponse(raw)).toThrow(/schema validation/i);
  });

  it('throws when reasoning is missing', () => {
    const raw = JSON.stringify({
      verdict: 'valid',
      confidence_score: 0.8,
      // reasoning omitted
      has_discrepancies: false,
      flagged_issues: [],
    });
    expect(() => parseLLMResponse(raw)).toThrow(/schema validation/i);
  });

  it('strips leading/trailing whitespace before parsing', () => {
    const raw = `   ${JSON.stringify({
      verdict: 'valid',
      confidence_score: 0.9,
      reasoning: 'All rules pass.',
      has_discrepancies: false,
      flagged_issues: [],
    })}   `;
    const result = parseLLMResponse(raw);
    expect(result.verdict).toBe('valid');
  });
});

// ---------------------------------------------------------------------------
// buildUserMessage — unit tests
// ---------------------------------------------------------------------------

describe('buildUserMessage', () => {
  it('builds a message with an image URL block and a text block', () => {
    const imageUrl = 'https://bucket.s3.amazonaws.com/images/door.jpg';
    const metadata = { date: '2024-06-15T12:00:00Z', location: 'London' };

    const message = buildUserMessage(imageUrl, metadata);

    expect(message.role).toBe('user');
    expect(Array.isArray(message.content)).toBe(true);

    const content = message.content as Array<{ type: string; source?: { url: string }; text?: string }>;
    const imageBlock = content.find((b) => b.type === 'image');
    const textBlock = content.find((b) => b.type === 'text');

    expect(imageBlock).toBeDefined();
    expect(imageBlock?.source?.url).toBe(imageUrl);
    expect(textBlock?.text).toContain('Submitted metadata:');
    expect(textBlock?.text).toContain('London');
  });

  it('includes all metadata fields in the text block', () => {
    const metadata = {
      date: '2024-01-01T08:00:00Z',
      tags: ['front', 'entrance'],
      user_id: 'user-42',
    };
    const message = buildUserMessage('https://example.com/img.jpg', metadata);
    const content = message.content as Array<{ type: string; text?: string }>;
    const textBlock = content.find((b) => b.type === 'text');
    expect(textBlock?.text).toContain('user-42');
    expect(textBlock?.text).toContain('front');
  });
});

// ---------------------------------------------------------------------------
// SYSTEM_PROMPT — sanity checks
// ---------------------------------------------------------------------------

describe('SYSTEM_PROMPT', () => {
  it('contains all three validation rules', () => {
    expect(SYSTEM_PROMPT).toContain('SUBJECT');
    expect(SYSTEM_PROMPT).toContain('LIGHTING CONSISTENCY');
    expect(SYSTEM_PROMPT).toContain('NO WATERMARKS');
  });

  it('contains all three verdict options', () => {
    expect(SYSTEM_PROMPT).toContain('"valid"');
    expect(SYSTEM_PROMPT).toContain('"invalid"');
    expect(SYSTEM_PROMPT).toContain('"needs_review"');
  });

  it('instructs the model to respond with JSON only', () => {
    expect(SYSTEM_PROMPT).toMatch(/respond only with a valid json/i);
  });
});
