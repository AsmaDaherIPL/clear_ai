/**
 * Zod request-body schemas for POST /classifications and POST /classifications/expand.
 *
 * Phase 2.3 hardening (backend security review H6 — prompt-injection surface):
 *   - description max length tightened from 250 to 200 (no real product
 *     description in the broker dataset exceeds 150 chars; the extra
 *     50 chars were prompt-injection runway).
 *   - .superRefine() runs detectInjectionShape() over the description.
 *     When the input looks like a prompt-injection attempt the schema
 *     emits a Zod issue with `params.kind = '<label>'`. The handler
 *     returns the standard `{error: 'invalid_body', detail: ...}` envelope
 *     before the LLM is invoked — attacker pays no Foundry tokens.
 *
 * Negative tests live in tests/routes/schemas.test.ts.
 */
import { z } from 'zod';
import { detectInjectionShape } from '../util/sanitise.js';

// Shared description validator. Extracted because both classify + expand
// take the same shape — keeping it DRY also means a single place to tune
// the length cap or the injection-shape rule.
const descriptionField = z
  .string()
  .min(1)
  .max(200)
  .superRefine((val, ctx) => {
    const detection = detectInjectionShape(val);
    if (detection) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: detection.reason,
        // The `params.kind` lets the route handler / frontend distinguish
        // between rejection categories without parsing the message string.
        params: { kind: detection.label },
      });
    }
  });

export const classifyBody = z.object({
  description: descriptionField,
});
export type ClassifyBody = z.infer<typeof classifyBody>;

export const expandBody = z.object({
  /**
   * Parent prefix (4–10 digits) OR a full 12-digit code. The 12-digit form is
   * accepted so the broker can surface SABER-deleted codes through the same
   * endpoint and receive the `code_deleted` refusal — for live (non-deleted)
   * 12-digit codes the route returns `already_most_specific`.
   */
  code: z
    .string()
    .regex(/^(\d{4,10}|\d{12})$/, 'parent code must be 4 to 10 digits, or a full 12-digit code'),
  description: descriptionField,
});
export type ExpandBody = z.infer<typeof expandBody>;
