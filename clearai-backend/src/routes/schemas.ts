import { z } from 'zod';

export const describeBody = z.object({
  description: z.string().min(1).max(2000),
});
export type DescribeBody = z.infer<typeof describeBody>;

export const expandBody = z.object({
  /**
   * Parent prefix declaring the branch under which to retrieve.
   *
   * MUST be 6 to 10 digits — anchored at both ends. We deliberately accept
   * odd lengths (7, 9) too, not just the canonical HS bucket boundaries
   * (6/8/10), because in practice users paste partial codes mid-typing and
   * the retrieval layer treats `code` as a `LIKE 'code%'` prefix anyway.
   * The 6-digit floor exists because anything shorter (chapter / heading)
   * fans out to too many candidates to be useful as a "parent under which
   * to expand". Negative tests live in `src/routes/schemas.test.ts`.
   */
  code: z
    .string()
    .regex(/^\d{6,10}$/, 'parent code must be 6 to 10 digits'),
  description: z.string().min(1).max(2000),
});
export type ExpandBody = z.infer<typeof expandBody>;

export const boostBody = z.object({
  /** 12-digit ZATCA code under inspection. */
  code: z.string().regex(/^\d{12}$/, 'must be exactly 12 digits'),
});
export type BoostBody = z.infer<typeof boostBody>;
