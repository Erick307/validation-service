import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { ImageMetadata, LLMResult } from '../models/types';
import { LLMResultSchema } from '../schemas/llmResult';

// ---------------------------------------------------------------------------
// Anthropic client singleton
// ---------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// ---------------------------------------------------------------------------
// System prompt — hardcoded validation rules (demo scope)
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are an image validation assistant. Your task is to analyze a photo and its associated metadata,
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
}`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the user-turn message content array for the Claude vision API call.
 * The image is passed by URL — Claude fetches it directly; we never buffer it.
 */
export function buildUserMessage(
  imageUrl: string,
  metadata: ImageMetadata
): Anthropic.MessageParam {
  return {
    role: 'user',
    content: [
      // The @anthropic-ai/sdk v0.24 typings only include base64 image sources;
      // URL-sourced images are supported by the API but not yet reflected in
      // the type definitions. Cast via unknown to satisfy the compiler.
      {
        type: 'image',
        source: {
          type: 'url',
          url: imageUrl,
        },
      } as unknown as Anthropic.ImageBlockParam,
      {
        type: 'text',
        text: `Submitted metadata:\n${JSON.stringify(metadata, null, 2)}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

/**
 * Call the Claude API with the image URL and metadata, then parse and validate
 * the structured JSON response.
 *
 * Throws on API error or if the response fails Zod validation — both are
 * treated as retriable failures by the job worker.
 */
export async function callLLM(
  imageUrl: string,
  metadata: ImageMetadata
): Promise<LLMResult> {
  const client = getClient();

  const response = await client.messages.create({
    model: config.CLAUDE_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [buildUserMessage(imageUrl, metadata)],
  });

  // Extract the text content from the first content block
  const rawText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return parseLLMResponse(rawText);
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw LLM text response into a validated LLMResult.
 * Exported for unit testing.
 *
 * Throws a descriptive error if parsing or Zod validation fails.
 */
export function parseLLMResponse(rawText: string): LLMResult {
  // Strip markdown code fences if the model wraps the JSON (e.g. ```json ... ```)
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed: unknown;

  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `LLM response is not valid JSON. Raw text: ${rawText.slice(0, 200)}`
    );
  }

  const result = LLMResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `LLM response failed schema validation: ${JSON.stringify(
        result.error.flatten().fieldErrors
      )}`
    );
  }

  return result.data;
}
