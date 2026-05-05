/**
 * Typed error classes for the batches module.
 * Surface .code on every instance so the centralised error handler can map
 * to the shared envelope { error: { code, message, details? } }.
 */

class BatchError extends Error {
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
    this.name = 'BatchError';
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.details = opts.details;
  }
}

export class BatchValidationError extends BatchError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: 'batch_validation_failed', message, statusCode: 400, details });
    this.name = 'BatchValidationError';
  }
}

export class BatchProcessingError extends BatchError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: 'batch_processing_failed', message, statusCode: 500, details });
    this.name = 'BatchProcessingError';
  }
}

export class BatchNotFoundError extends BatchError {
  constructor(id: string) {
    super({
      code: 'batch_not_found',
      message: `Batch not found: ${id}`,
      statusCode: 404,
      details: { id },
    });
    this.name = 'BatchNotFoundError';
  }
}

export class BatchTooLargeError extends BatchError {
  constructor(rowCount: number, maxRows: number) {
    super({
      code: 'batch_too_large',
      message: `Upload has ${rowCount} rows, which exceeds the limit of ${maxRows}`,
      statusCode: 413,
      details: { rowCount, maxRows },
    });
    this.name = 'BatchTooLargeError';
  }
}
