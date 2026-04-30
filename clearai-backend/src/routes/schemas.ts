/**
 * Zod request-body schemas for the classifications API.
 *
 *   classifyBody  — POST /classifications
 *   expandBody    — POST /classifications/expand
 *
 * The other endpoints (GET /classifications/{id}, POST /classifications/{id}/feedback,
 * POST /classifications/{id}/submission-description) have inline schemas next to
 * their handlers because they're trivially small or path-only.
 *
 * Removed: boostBody — the /boost endpoint was retired (no live caller).
 */
import { z } from 'zod';

export const classifyBody = z.object({
  description: z.string().min(1).max(250),
});
export type ClassifyBody = z.infer<typeof classifyBody>;

export const expandBody = z.object({
  /**
   * Parent prefix declaring the branch under which to retrieve.
   *
   * MUST be 4 to 10 digits. We deliberately accept odd lengths (5, 7, 9)
   * too, not just the canonical HS bucket boundaries (4/6/8/10), because
   * in practice users paste partial codes mid-typing and the retrieval
   * layer treats `code` as a `LIKE 'code%'` prefix anyway.
   *
   * The floor was historically 6 ("anything shorter fans out to too
   * many candidates"), but heading-level acceptance (ADR-0019) now
   * regularly produces 4-digit picks — and the natural follow-up is
   * "given 1509, here's a fuller description, refine to a leaf."
   * Retrieval + gate + picker can handle 4-digit parents fine; we
   * weren't actually getting bitten by the wide branch.
   *
   * Negative tests live in `tests/routes/schemas.test.ts`.
   */
  code: z
    .string()
    .regex(/^\d{4,10}$/, 'parent code must be 4 to 10 digits'),
  description: z.string().min(1).max(250),
});
export type ExpandBody = z.infer<typeof expandBody>;
