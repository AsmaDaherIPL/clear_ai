/**
 * Stamp SAR-equivalent fields on a CanonicalLineItem at parse / ingest time.
 *
 * ZATCA only accepts SAR-denominated invoices. Doing the conversion once at
 * ingest gives us:
 *   • a single audit point (one rate per item, captured in fx_rate_id)
 *   • SAR-clean inputs downstream — splitter, sanity, ZATCA renderer all
 *     read `valueAmountSar` without re-converting
 *   • replay determinism — rerunning a classification against the same item
 *     row produces the same SAR amount regardless of when it ran
 *
 * Reject (throw) policy: when no rate is on file for the merchant's
 * currency, throw FxRateMissingError. Callers surface the error as a hard
 * reject — ops seeds the rate in fx_rates and the merchant re-uploads.
 * V1 deliberately does NOT fall back to a default rate.
 */
import type { CanonicalLineItem } from '../../operators/operator-config.types.js';
import { convertToSar, FxRateMissingError } from '../../reference-data/fx.service.js';

export { FxRateMissingError };

export async function stampFxFields(item: CanonicalLineItem): Promise<CanonicalLineItem> {
  if (typeof item.valueAmount !== 'number' || !Number.isFinite(item.valueAmount)) {
    // Missing or non-numeric value; leave SAR fields unset. Downstream
    // stages should treat absent valueAmountSar the same way they treat
    // an absent valueAmount.
    return item;
  }
  if (typeof item.currencyCode !== 'string' || item.currencyCode.length !== 3) {
    return item;
  }

  const conversion = await convertToSar(item.valueAmount, item.currencyCode);
  return {
    ...item,
    valueAmountSar: conversion.sarAmount,
    fxRate: conversion.rate,
    fxRateAsOf: conversion.rateAsOf,
    fxRateId: conversion.rateId,
  };
}
