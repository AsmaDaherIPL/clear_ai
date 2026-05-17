/**
 * Currency → SAR conversion service.
 *
 * ZATCA accepts invoices in any source currency (the renderer emits
 * source amounts + the row's currency code), so this conversion is NOT
 * for the XML. It exists so the pipeline can compare values across
 * mixed-currency batches against SAR-denominated decision thresholds —
 * specifically the HV/LV partition (ZATCA_HV_THRESHOLD_SAR = 1000) and
 * the LV invoice cap (ZATCA_LV_INVOICE_CAP_SAR = 1000). The 1000 SAR
 * break-point is fixed regardless of source currency; FX exists to
 * project every row into that common unit.
 *
 * The converted value is stamped at parse time on
 * canonical.valueAmountSar; canonical.valueAmount stays in source
 * currency for the renderer. SAR itself is a passthrough (rate = 1,
 * no DB lookup).
 *
 * Lookup rule: the most recent row where `as_of_date <= today`. If no
 * rate is on file for the supplied currency, throw — the parse stage
 * surfaces the rejection upstream so ops can seed the missing rate
 * and re-upload.
 */
import { getPool } from '../../db/client.js';

export interface FxConversion {
  /** Original numeric value (passthrough). */
  originalAmount: number;
  /** Original 3-letter currency code (uppercase). */
  originalCurrency: string;
  /** Value expressed in SAR after applying `rate`. Rounded to 2 decimals. */
  sarAmount: number;
  /** Rate used (units of SAR per 1 unit of original currency). */
  rate: number;
  /** Calendar date of the rate row used. */
  rateAsOf: string;
  /** Audit pointer to the fx_rates row. */
  rateId: string;
  /** Provenance (e.g. 'manual_seed'). */
  rateSource: string;
}

export class FxRateMissingError extends Error {
  readonly code = 'fx_rate_missing';
  constructor(public readonly currency: string, public readonly asOfDate: string) {
    super(`No FX rate on file for ${currency} on or before ${asOfDate}. Seed the rate in fx_rates and re-upload.`);
    this.name = 'FxRateMissingError';
  }
}

function todayInRiyadh(): string {
  // ZATCA operates in Asia/Riyadh. Use the local calendar date for the
  // rate-lookup window so a batch uploaded at 23:30 UTC still picks the
  // Riyadh "today" rate.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

/**
 * Convert an amount in the merchant's currency into SAR.
 *
 * @throws FxRateMissingError if no rate is on file for the currency.
 */
export async function convertToSar(
  amount: number,
  currencyCode: string,
  opts?: { asOfDate?: string },
): Promise<FxConversion> {
  const currency = currencyCode.toUpperCase();
  const asOf = opts?.asOfDate ?? todayInRiyadh();

  if (currency === 'SAR') {
    return {
      originalAmount: amount,
      originalCurrency: 'SAR',
      sarAmount: round2(amount),
      rate: 1,
      rateAsOf: asOf,
      rateId: 'sar-passthrough',
      rateSource: 'identity',
    };
  }

  const pool = getPool();
  const r = await pool.query<{ id: string; rate: string; as_of_date: string; source: string }>(
    `SELECT id, rate::text AS rate, as_of_date::text AS as_of_date, source
       FROM fx_rates
      WHERE quote_currency = $1
        AND as_of_date <= $2::date
      ORDER BY as_of_date DESC
      LIMIT 1`,
    [currency, asOf],
  );

  if (r.rowCount === 0 || !r.rows[0]) {
    throw new FxRateMissingError(currency, asOf);
  }
  const row = r.rows[0];
  const rate = Number(row.rate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new FxRateMissingError(currency, asOf);
  }

  return {
    originalAmount: amount,
    originalCurrency: currency,
    sarAmount: round2(amount * rate),
    rate,
    rateAsOf: row.as_of_date,
    rateId: row.id,
    rateSource: row.source,
  };
}

/** Bulk fetch of current rates for the SPA dropdown / display. */
export async function listCurrentFxRates(): Promise<
  Array<{ quoteCurrency: string; rate: number; asOfDate: string }>
> {
  const pool = getPool();
  const r = await pool.query<{ quote_currency: string; rate: string; as_of_date: string }>(
    `SELECT DISTINCT ON (quote_currency)
            quote_currency, rate::text AS rate, as_of_date::text AS as_of_date
       FROM fx_rates
       WHERE as_of_date <= $1::date
       ORDER BY quote_currency, as_of_date DESC`,
    [todayInRiyadh()],
  );
  return r.rows.map((row) => ({
    quoteCurrency: row.quote_currency,
    rate: Number(row.rate),
    asOfDate: row.as_of_date,
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
