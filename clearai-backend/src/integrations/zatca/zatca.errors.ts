/**
 * Errors raised by the integrations/zatca/ surface. Renderer also exports
 * ZatcaRenderError next to the renderer for tight coupling; this re-export
 * is the integration-wide catch point.
 */

export { ZatcaRenderError } from './declaration/declaration.template.js';

export class ZatcaSchemaValidationError extends Error {
  readonly code = 'zatca_schema_validation_error';
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ZatcaSchemaValidationError';
  }
}
