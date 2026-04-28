import { z } from 'zod';

/**
 * Zod schema for the structured JSON response returned by the LLM.
 * If the LLM response cannot be parsed or fails this schema, the job is
 * treated as failed and pg-boss will schedule a retry.
 */
export const LLMResultSchema = z.object({
  verdict: z.enum(['valid', 'invalid', 'needs_review'], {
    errorMap: () => ({
      message: "verdict must be 'valid', 'invalid', or 'needs_review'",
    }),
  }),
  confidence_score: z
    .number()
    .min(0, 'confidence_score must be >= 0')
    .max(1, 'confidence_score must be <= 1'),
  reasoning: z.string().min(1, 'reasoning must not be empty'),
  has_discrepancies: z.boolean(),
  flagged_issues: z.array(z.string()),
});

export type LLMResultInput = z.input<typeof LLMResultSchema>;
export type LLMResultOutput = z.output<typeof LLMResultSchema>;
