/**
 * Zod schemas for declaration-run boundaries.
 *
 * The actual multipart parse is done in declaration-run.controller.ts; these
 * schemas validate the post-parse fields. The mode default mirrors the column
 * default ('classify_and_declare') for safety, but the controller still
 * enforces the value explicitly.
 *
 * 2026-05-12 rename cutover: `operator_slug`, `callback_url`, `metadata`
 * were removed from the multipart body per the API audit spec — V1 is
 * single-operator (`naqel`) and the optional metadata channel wasn't
 * consumed by any caller. Only `file` + `mode` remain on the wire.
 */
import { z } from 'zod';

export const DeclarationRunModeSchema = z.enum(['classify_only', 'classify_and_declare']);

export const CreateBatchFieldsSchema = z.object({
  mode: DeclarationRunModeSchema.optional().default('classify_and_declare'),
});

export type CreateDeclarationRunFields = z.infer<typeof CreateBatchFieldsSchema>;

export const PatchBatchSchema = z.object({
  status: z.literal('cancelled'),
});

export type PatchDeclarationRunBody = z.infer<typeof PatchBatchSchema>;
