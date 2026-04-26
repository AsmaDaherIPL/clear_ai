import { z } from 'zod';

export const describeBody = z.object({
  description: z.string().min(1).max(2000),
});
export type DescribeBody = z.infer<typeof describeBody>;

export const expandBody = z.object({
  /**
   * Parent prefix declaring the branch under which to retrieve.
   *
   * MUST be exactly 4, 6, 8, or 10 digits — anchored at both ends and grouped
   * as a single alternative set. The earlier pattern `^\d{4}|\d{6}|\d{8}|\d{10}$`
   * was wrong: regex alternation has lower precedence than anchors, so it
   * actually matched "starts with 4 digits OR contains 6 digits OR contains
   * 8 digits OR ends with 10 digits", letting `12345` and `abc123456def`
   * through to the retrieval path. Negative tests live in
   * `src/routes/schemas.test.ts`.
   */
  code: z
    .string()
    .regex(/^(?:\d{4}|\d{6}|\d{8}|\d{10})$/, 'parent code must be exactly 4, 6, 8 or 10 digits'),
  description: z.string().min(1).max(2000),
});
export type ExpandBody = z.infer<typeof expandBody>;

export const boostBody = z.object({
  /** 12-digit ZATCA code under inspection. */
  code: z.string().regex(/^\d{12}$/, 'must be exactly 12 digits'),
});
export type BoostBody = z.infer<typeof boostBody>;
