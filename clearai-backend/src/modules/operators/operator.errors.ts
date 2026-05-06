/**
 * Custom error classes for the tenants module.
 *
 * Tagged with `code` strings that the centralized error handler maps to the
 * shared error envelope: { error: { code, message, details? } }.
 */

export class TenantError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(opts: {
    code: string;
    message: string;
    statusCode: number;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = 'TenantError';
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.details = opts.details;
  }
}

export class OperatorNotFoundError extends TenantError {
  constructor(slugOrId: string) {
    super({
      code: 'tenant_not_found',
      message: `Tenant not found: ${slugOrId}`,
      statusCode: 404,
      details: { slugOrId },
    });
    this.name = 'OperatorNotFoundError';
  }
}

export class MappingValidationError extends TenantError {
  constructor(slug: string, problems: ReadonlyArray<string>) {
    super({
      code: 'tenant_mapping_invalid',
      message: `Tenant '${slug}' has invalid field mappings`,
      statusCode: 500,
      details: { slug, problems: [...problems] },
    });
    this.name = 'MappingValidationError';
  }
}

export class RequiredFieldMissingError extends TenantError {
  constructor(slug: string, rowIndex: number, field: string) {
    super({
      code: 'required_field_missing',
      message: `Required field '${field}' missing on row ${rowIndex} for operator '${slug}'`,
      statusCode: 422,
      details: { slug, rowIndex, field },
    });
    this.name = 'RequiredFieldMissingError';
  }
}
