/** Zod request-body schemas for POST /classifications and POST /classifications/expand. */
import { z } from 'zod';

export const classifyBody = z.object({
  description: z.string().min(1).max(250),
});
export type ClassifyBody = z.infer<typeof classifyBody>;

export const expandBody = z.object({
  /** Parent prefix; 4 to 10 digits. */
  code: z
    .string()
    .regex(/^\d{4,10}$/, 'parent code must be 4 to 10 digits'),
  description: z.string().min(1).max(250),
});
export type ExpandBody = z.infer<typeof expandBody>;
