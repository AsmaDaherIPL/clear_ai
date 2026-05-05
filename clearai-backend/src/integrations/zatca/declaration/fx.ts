/**
 * FX rates: currency-code (ISO-4217) -> SAR rate.
 *
 * Used to convert `valueAmount` to SAR before HV/LV partition. The threshold
 * (`tenants.hv_threshold_sar`) is denominated in SAR; without conversion, a
 * 1500 AED row (~1530 SAR) would be checked as 1500 SAR (still HV here, but
 * a 1100 AED row ≈ 1122 SAR is LV under the wrong assumption).
 *
 * v0 reads from env BATCH_FX_RATES_TO_SAR (a JSON object). v1 will pull from
 * a daily-refresh table or an FX provider; the public surface stays the
 * same.
 *
 * SAR is implicitly 1.0. Missing currencies log a warning and fall back to
 * identity (1.0) — this is intentionally conservative: emitting an
 * incorrect HV/LV partition is worse than treating an unknown currency as
 * SAR-equivalent at parse time, which keeps the row in the safe (LV) band
 * unless the raw amount itself crosses the threshold.
 */
import { env } from '../../../config/env.js';

let _ratesCache: ReadonlyMap<string, number> | null = null;
const _warnedCurrencies = new Set<string>();

/** Parse the env JSON once; cache for the lifetime of the process. */
function ratesToSar(): ReadonlyMap<string, number> {
  if (_ratesCache) return _ratesCache;
  const raw = env().BATCH_FX_RATES_TO_SAR;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`BATCH_FX_RATES_TO_SAR is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('BATCH_FX_RATES_TO_SAR must be a JSON object');
  }
  const out = new Map<string, number>();
  for (const [code, rate] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`BATCH_FX_RATES_TO_SAR['${code}']: must be a positive finite number, got ${rate}`);
    }
    out.set(code.toUpperCase(), rate);
  }
  // SAR -> 1 always. Caller-supplied SAR rate (if any) is ignored to avoid
  // accidental misconfiguration.
  out.set('SAR', 1);
  _ratesCache = out;
  return out;
}

/**
 * Convert an amount in `currencyCode` to SAR.
 *
 * Currencies not present in the rate table fall back to identity (rate = 1)
 * and emit a one-time warning per currency code. Use sparingly — if a
 * tenant ships a new currency, add it to BATCH_FX_RATES_TO_SAR rather than
 * silently degrading.
 */
export function toSar(amount: number, currencyCode: string): number {
  if (!Number.isFinite(amount)) return 0;
  const code = currencyCode.toUpperCase();
  const rate = ratesToSar().get(code);
  if (rate === undefined) {
    if (!_warnedCurrencies.has(code)) {
      _warnedCurrencies.add(code);
      // eslint-disable-next-line no-console
      console.warn(
        `[fx] no SAR rate for currency '${code}' — treating as 1:1. ` +
          `Add it to BATCH_FX_RATES_TO_SAR.`,
      );
    }
    return amount;
  }
  return amount * rate;
}

/** TEST-ONLY: drop the cached rates so the next call re-reads env. */
export function _resetFxCacheForTests(): void {
  _ratesCache = null;
  _warnedCurrencies.clear();
}
