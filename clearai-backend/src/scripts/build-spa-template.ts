/**
 * Build the SPA's batch upload template files.
 *
 * Outputs:
 *   clearai-frontend/public/templates/clearai-batch-template.xlsx
 *   clearai-frontend/public/templates/clearai-batch-template.csv
 *
 * The XLSX has 3 sheets: CommercialInvoice (data entry), UnitType (enum),
 * Currency (enum). The CSV mirrors the data-entry sheet only.
 *
 * The 15-column header matches src/scripts/seed-operators.ts NAQEL_MAPPINGS
 * — the canonicaliser already accepts this shape end-to-end.
 *
 * Re-run any time the canonical column set changes. Idempotent.
 */
import { utils, write } from 'xlsx';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HEADERS = [
  'Description',
  'WaybillNo',
  'CustomsCommodityCode',
  'SKU',
  'Amount',
  'Currency',
  'Quantity',
  'UnitType',
  'weight',
  'ClientID',
  'CountryofManufacture',
  'DestinationStationID',
  'ConsigneeName',
  'ConsigneeNationalID',
  'Mobile',
] as const;

const EXAMPLE_ROW = [
  'Wireless headphones with bluetooth',
  'WB-TEST-0001',
  '851830000000',
  'SKU-TEST-001',
  '150.00',
  'SAR',
  '1',
  'PIECE',
  '0.25',
  'CLIENT-TEST',
  'CN',
  'RUH',
  'Test Consignee',
  '1234567890',
  '966500000000',
];

const UNIT_TYPES = [
  'Box', 'Bag', 'Crate', 'Pallet', 'Carton', 'Barrel', 'Bundle', 'Roll',
  'Case', 'Drum', 'Package', 'Tube', 'Container', 'Bin', 'Jar', 'Piece',
];

// ISO 4217 currency codes Naqel ships shipments in (lifted from the
// Web Portal Client Commercial Invoice template's Currency sheet).
const CURRENCIES: Array<[string, string]> = [
  ['SAR', 'Saudi Riyal'],
  ['AED', 'UAE Dirham'],
  ['USD', 'US Dollar'],
  ['EUR', 'Euro'],
  ['GBP', 'Pound Sterling'],
  ['JPY', 'Japanese Yen'],
  ['CNY', 'Chinese Yuan'],
  ['INR', 'Indian Rupee'],
  ['KWD', 'Kuwaiti Dinar'],
  ['QAR', 'Qatari Rial'],
  ['BHD', 'Bahraini Dinar'],
  ['OMR', 'Omani Rial'],
  ['JOD', 'Jordanian Dinar'],
  ['EGP', 'Egyptian Pound'],
  ['TRY', 'Turkish Lira'],
  ['CHF', 'Swiss Franc'],
  ['CAD', 'Canadian Dollar'],
  ['AUD', 'Australian Dollar'],
  ['HKD', 'Hong Kong Dollar'],
  ['SGD', 'Singapore Dollar'],
  ['NOK', 'Norwegian Krone'],
  ['SEK', 'Swedish Krona'],
];

function buildXlsx(): Buffer {
  const wb = utils.book_new();

  const invoiceSheet = utils.aoa_to_sheet([HEADERS as unknown as string[], EXAMPLE_ROW]);
  utils.book_append_sheet(wb, invoiceSheet, 'CommercialInvoice');

  const unitSheet = utils.aoa_to_sheet([['UnitType'], ...UNIT_TYPES.map((u) => [u])]);
  utils.book_append_sheet(wb, unitSheet, 'UnitType');

  const currencySheet = utils.aoa_to_sheet([['Code', 'Name'], ...CURRENCIES]);
  utils.book_append_sheet(wb, currencySheet, 'Currency');

  return write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function buildCsv(): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [HEADERS.map(escape).join(','), EXAMPLE_ROW.map(escape).join(',')].join('\n') + '\n';
}

function main(): void {
  const repoRoot = resolve(__dirname, '..', '..', '..');
  const outDir = resolve(repoRoot, 'clearai-frontend', 'public', 'templates');
  mkdirSync(outDir, { recursive: true });

  const xlsxPath = resolve(outDir, 'clearai-batch-template.xlsx');
  const csvPath = resolve(outDir, 'clearai-batch-template.csv');

  writeFileSync(xlsxPath, buildXlsx());
  writeFileSync(csvPath, buildCsv(), 'utf8');

  // eslint-disable-next-line no-console
  console.log(`wrote ${xlsxPath}`);
  // eslint-disable-next-line no-console
  console.log(`wrote ${csvPath}`);
}

main();
