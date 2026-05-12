/**
 * Typed error classes for the declaration-runs module.
 * Surface .code on every instance so the centralised error handler can map
 * to the shared envelope { error: { code, message, details? } }.
 */

class DeclarationRunError extends Error {
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
    this.name = 'DeclarationRunError';
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.details = opts.details;
  }
}

export class BatchValidationError extends DeclarationRunError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: 'declaration_run_validation_failed', message, statusCode: 400, details });
    this.name = 'BatchValidationError';
  }
}

export class DeclarationRunProcessingError extends DeclarationRunError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: 'declaration_run_processing_failed', message, statusCode: 500, details });
    this.name = 'DeclarationRunProcessingError';
  }
}

export class BatchNotFoundError extends DeclarationRunError {
  constructor(id: string) {
    super({
      code: 'declaration_run_not_found',
      message: `Declaration set not found: ${id}`,
      statusCode: 404,
      details: { id },
    });
    this.name = 'BatchNotFoundError';
  }
}

export class BatchTooLargeError extends DeclarationRunError {
  constructor(rowCount: number, maxRows: number) {
    super({
      code: 'declaration_run_too_large',
      message: `Upload has ${rowCount} rows, which exceeds the limit of ${maxRows}`,
      statusCode: 413,
      details: { rowCount, maxRows },
    });
    this.name = 'BatchTooLargeError';
  }
}
