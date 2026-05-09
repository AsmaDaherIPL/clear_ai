/**
 * XML namespaces in the decsub:saudiEDI envelope. The decsub URI is
 * per-operator (operators.zatca_declaration_namespace) and threaded
 * through the renderer; only the static URIs that ship with every
 * envelope live here.
 */
export const STATIC_NAMESPACES = Object.freeze({
  cm: 'http://www.saudiedi.com/schema/common',
  sau: 'http://www.saudiedi.com/schema/sau',
  deccm: 'http://www.saudiedi.com/schema/deccm',
  deckey: 'http://www.saudiedi.com/schema/deckey',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
});
