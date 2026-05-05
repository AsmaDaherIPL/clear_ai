/**
 * Typed error classes for the declaration-sets module.
 * Surface .code on every instance so the centralised error handler can map
 * to the shared envelope { error: { code, message, details? } }.
 */

class DeclarationSetError extends Error {
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
    this.name = 'DeclarationSetError';
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.details = opts.details;
  }
}

export class DeclarationSetValidationError extends DeclarationSetError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: 'declaration_set_validation_failed', message, statusCode: 400, details });
    this.name = 'DeclarationSetValidationError';
  }
}

export class DeclarationSetProcessingError extends DeclarationSetError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: 'declaration_set_processing_failed', message, statusCode: 500, details });
    this.name = 'DeclarationSetProcessingError';
  }
}

export class DeclarationSetNotFoundError extends DeclarationSetError {
  constructor(id: string) {
    super({
      code: 'declaration_set_not_found',
      message: `Declaration set not found: ${id}`,
      statusCode: 404,
      details: { id },
    });
    this.name = 'DeclarationSetNotFoundError';
  }
}

export class DeclarationSetTooLargeError extends DeclarationSetError {
  constructor(rowCount: number, maxRows: number) {
    super({
      code: 'declaration_set_too_large',
      message: `Upload has ${rowCount} rows, which exceeds the limit of ${maxRows}`,
      statusCode: 413,
      details: { rowCount, maxRows },
    });
    this.name = 'DeclarationSetTooLargeError';
  }
}
