/**
 * XML namespace URIs for the ZATCA decsub:saudiEDI envelope.
 *
 * The primary URI lives in env (ZATCA_DECLARATION_NS) so it can be updated
 * without redeploy if ZATCA bumps a version. Additional URIs that ship as
 * part of the envelope header are constants here — they're stable across
 * carrier configurations.
 */
import { env } from '../../config/env.js';

export function decsubNamespace(): string {
  return env().ZATCA_DECLARATION_NS;
}

export const STATIC_NAMESPACES = Object.freeze({
  cm: 'http://www.saudiedi.com/schema/common',
  sau: 'http://www.saudiedi.com/schema/sau',
  deccm: 'http://www.saudiedi.com/schema/deccm',
  deckey: 'http://www.saudiedi.com/schema/deckey',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
});
