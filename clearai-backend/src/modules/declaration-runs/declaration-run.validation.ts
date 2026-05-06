/**
 * Zod schemas for declaration-run boundaries.
 *
 * The actual multipart parse is done in declaration-run.controller.ts; these
 * schemas validate the post-parse fields. The mode default mirrors the column
 * default ('classify_and_declare') for safety, but the controller still
 * enforces the value explicitly.
 */
import { z } from 'zod';

export const DeclarationRunModeSchema = z.enum(['classify_only', 'classify_and_declare']);

export const CreateDeclarationRunFieldsSchema = z.object({
  tenant_slug: z.string().min(1).regex(/^[a-z][a-z0-9_]{2,31}$/),
  mode: DeclarationRunModeSchema.optional().default('classify_and_declare'),
  callback_url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type CreateDeclarationRunFields = z.infer<typeof CreateDeclarationRunFieldsSchema>;

export const PatchDeclarationRunSchema = z.object({
  status: z.literal('cancelled'),
});

export type PatchDeclarationRunBody = z.infer<typeof PatchDeclarationRunSchema>;
