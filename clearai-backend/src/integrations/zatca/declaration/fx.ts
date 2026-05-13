/**
 * FX → SAR for ZATCA rendering.
 *
 * Post 2026-05-13: items are converted to SAR at parse time and the
 * SAR-equivalent is stamped on `CanonicalLineItem.valueAmountSar`. This
 * module is the renderer-side fallback for legacy items / unit tests that
 * still ask for an ad-hoc conversion. New code should read
 * `valueAmountSar` directly off the item — no synchronous FX lookup is
 * needed during rendering.
 *
 * The env-based BATCH_FX_RATES_TO_SAR JSON is gone. Conversions now go
 * through fx_rates (manual-seed table). Missing currencies hard-reject
 * via FxRateMissingError at parse time, so the renderer never sees an
 * untranslated item.
 */
import { convertToSar } from '../../../modules/reference-data/fx.service.js';

/**
 * Convert an amount in `currencyCode` to SAR. ASYNC because it hits the
 * fx_rates table. Prefer reading `valueAmountSar` off the item — only
 * call this from one-off paths that don't have a parsed item available.
 */
export async function toSar(amount: number, currencyCode: string): Promise<number> {
  const c = await convertToSar(amount, currencyCode);
  return c.sarAmount;
}
