/**
 * Zod schemas for batch boundaries.
 *
 * The actual multipart parse is done in batch.controller.ts; these schemas
 * validate the post-parse fields. The mode default mirrors the column
 * default ('classify_and_declare') for safety, but the controller still
 * enforces the value explicitly.
 */
import { z } from 'zod';

export const BatchModeSchema = z.enum(['classify_only', 'classify_and_declare']);

export const CreateBatchFieldsSchema = z.object({
  tenant_slug: z.string().min(1).regex(/^[a-z][a-z0-9_]{2,31}$/),
  mode: BatchModeSchema.optional().default('classify_and_declare'),
  callback_url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type CreateBatchFields = z.infer<typeof CreateBatchFieldsSchema>;

export const PatchBatchSchema = z.object({
  status: z.literal('cancelled'),
});

export type PatchBatchBody = z.infer<typeof PatchBatchSchema>;
