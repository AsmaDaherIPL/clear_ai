/**
 * Seed reference lookup data from Naqel's mapping xlsx.
 *
 * Source:
 *   naqel-shared-data/Naqel (Fields details + Mapping data).xlsx
 *
 * The six mapping sheets land in two tables:
 *
 *   ── Universal Tabadul reference data → tabadul_codes (operator-agnostic) ──
 *   sheet                          code_type              source -> canonical (+ metadata)
 *   ─────────────────────────────  ─────────────────────  ──────────────────────────────────
 *   CurrencyMapping                currency_code          ISO-4217 (e.g. SAR)
 *                                                         -> TabdulCurrencyId (e.g. '100')
 *   Tabadul CountryCode            country_of_origin      INTLCODE (ISO alpha-2, e.g. 'SA')
 *                                                         -> CountryCode (e.g. '145');
 *                                                         metadata: { name, fname }
 *   Tabdul City                    tabdul_city            CITY_CD (Tabdul city id)
 *                                                         -> CITY_ARB_NAME (Arabic city name);
 *                                                         metadata: { engName, intlCode,
 *                                                         countryCode }
 *
 *   ── Operator-specific lookups → operator_lookups (FK on operators.id) ──
 *   sheet                          lookup_type            source -> canonical (+ metadata)
 *   ─────────────────────────────  ─────────────────────  ──────────────────────────────────
 *   CountryOfOriginClientMapping   client_country         ClientID -> Countryoforigin (numeric)
 *   SourceCompanyPortMaping        client_source_company  `${ClientID}:${CustRegPortCode}` -> SourceCompanyNo;
 *                                                         metadata: { sourceCompanyName,
 *                                                         custRegPortCode, clientId }
 *   CityMaping                     destination_station    InfoCityId (== DestinationStationID)
 *                                                         -> TabdulCityId
 *
 * Hot-path renderer queries (the runner merges both tables into one Map):
 *   • currency:        lookup('currency_code', row.currencyCode) -> '100'           (tabadul_codes)
 *   • country origin:  lookup('country_of_origin', row.countryOfOrigin) -> '145'    (tabadul_codes)
 *   • client default:  lookup('client_country', row.clientId) -> '145'              (operator_lookups)
 *   • source company:  lookup('client_source_company', `${clientId}:${port}`)
 *                        -> { canonical: '383668', metadata: { sourceCompanyName, ... } }   (operator_lookups)
 *   • destination:     city = lookup('destination_station', row.destinationStationId)        (operator_lookups)
 *                      then nameAr = lookup('tabdul_city', city)                              (tabadul_codes)
 *
 * Idempotent — re-running re-asserts rows. Universal tables are upserted on
 * (code_type, source_value); operator-specific tables are DELETE+re-insert
 * scoped to (operator_id, lookup_type) so other operators are untouched.
 *
 * Usage:
 *   pnpm db:seed:operator-lookups
 *   tsx src/scripts/seed-operator-lookups.ts --file path/to/other.xlsx --operator aramex
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import * as XLSX from 'xlsx';
import { and, eq } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';
import { operatorLookups, tabadulCodes } from '../db/schema.js';
import { getOperatorBySlug } from '../modules/operators/operator.repository.js';

interface SheetRow {
  source: string;
  canonical: string;
  metadata: Record<string, unknown>;
}

type SheetReader = (sheet: XLSX.WorkSheet) => SheetRow[];

interface SheetSpec {
  sheetName: string;
  /** snake_case category — code_type for tabadul, lookup_type for operator_lookups. */
  type: string;
  /** 'universal' rows go in tabadul_codes; 'operator' rows in operator_lookups. */
  scope: 'universal' | 'operator';
  read: SheetReader;
}

const NAQEL_SHEETS: ReadonlyArray<SheetSpec> = [
  {
    sheetName: 'CurrencyMapping',
    type: 'currency_code',
    scope: 'universal',
    read: (sheet) => {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
      return rows
        .map((r) => ({
          source: String(r['InfoTraclCurCode'] ?? '').trim(),
          canonical: String(r['TabdulCurrencyId'] ?? '').trim(),
          metadata: { infoTrackCurrencyId: String(r['InfoTrackCurrencyId'] ?? '').trim() },
        }))
        .filter((x) => x.source !== '' && x.canonical !== '');
    },
  },
  {
    sheetName: 'Tabadul CountryCode',
    type: 'country_of_origin',
    scope: 'universal',
    read: (sheet) => {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
      const seen = new Set<string>();
      const out: SheetRow[] = [];
      for (const r of rows) {
        const intlRaw = String(r['INTLCODE'] ?? '').trim();
        if (intlRaw === '' || intlRaw === 'NULL' || intlRaw.length !== 2) continue;
        const source = intlRaw.toUpperCase();
        if (seen.has(source)) continue;
        seen.add(source);
        const canonical = String(r['CountryCode'] ?? '').trim();
        if (canonical === '') continue;
        out.push({
          source,
          canonical,
          metadata: {
            name: String(r['Name'] ?? '').trim(),
            fname: String(r['FName'] ?? '').trim(),
          },
        });
      }
      return out;
    },
  },
  {
    sheetName: 'CountryOfOriginClientMapping',
    type: 'client_country',
    scope: 'operator',
    read: (sheet) => {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
      return rows
        .map((r) => ({
          source: String(r['ClientID'] ?? '').trim(),
          canonical: String(r['Countryoforigin'] ?? '').trim(),
          metadata: {},
        }))
        .filter((x) => x.source !== '' && x.canonical !== '');
    },
  },
  {
    sheetName: 'SourceCompanyPortMaping',
    type: 'client_source_company',
    scope: 'operator',
    read: (sheet) => {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
      const out: SheetRow[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const clientId = String(r['ClientID'] ?? '').trim();
        const port = String(r['CustRegPortCode'] ?? '').trim();
        const sourceCompanyNo = String(r['SourceCompanyNo'] ?? '').trim();
        const sourceCompanyName = String(r['SourceCompanyName'] ?? '').trim();
        if (clientId === '' || port === '' || sourceCompanyNo === '') continue;
        const composite = `${clientId}:${port}`;
        if (seen.has(composite)) continue;
        seen.add(composite);
        out.push({
          source: composite,
          canonical: sourceCompanyNo,
          metadata: { sourceCompanyName, custRegPortCode: port, clientId },
        });
      }
      return out;
    },
  },
  {
    sheetName: 'CityMaping',
    type: 'destination_station',
    scope: 'operator',
    read: (sheet) => {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
      return rows
        .map((r) => ({
          source: String(r['InfoCityId'] ?? '').trim(),
          canonical: String(r['TabdulCityId'] ?? '').trim(),
          metadata: {},
        }))
        .filter((x) => x.source !== '' && x.canonical !== '');
    },
  },
  {
    sheetName: 'Tabdul City',
    type: 'tabdul_city',
    scope: 'universal',
    read: (sheet) => {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
      return rows
        .map((r) => ({
          source: String(r['CITY_CD'] ?? '').trim(),
          canonical: String(r['CITY_ARB_NAME'] ?? '').trim(),
          metadata: {
            engName: String(r['CITY_ENG_NAME'] ?? '').trim(),
            intlCode: String(r['CITY_INTL_CD'] ?? '').trim(),
            countryCode: String(r['CTRY_CD'] ?? '').trim(),
          },
        }))
        .filter((x) => x.source !== '' && x.canonical !== '');
    },
  },
];

const DEFAULT_NAQEL_PATH = resolvePath(
  process.cwd(),
  '../naqel-shared-data/Naqel (Fields details + Mapping data).xlsx',
);
const DEFAULT_OPERATOR = 'naqel';

interface Args {
  filePath: string;
  operator: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let filePath = DEFAULT_NAQEL_PATH;
  let operator = DEFAULT_OPERATOR;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file' && args[i + 1]) {
      filePath = resolvePath(args[++i]!);
    } else if (a === '--operator' && args[i + 1]) {
      operator = args[++i]!;
    }
  }
  return { filePath, operator };
}

async function main(): Promise<void> {
  const { filePath, operator } = parseArgs();

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    console.error(`Place Naqel's mapping workbook at the path above, or pass --file.`);
    process.exit(1);
  }

  const operatorRow = await getOperatorBySlug(operator);
  if (!operatorRow) {
    console.error(`Operator '${operator}' not found in operators table — run seed-operators first.`);
    process.exit(1);
  }
  const operatorId = operatorRow.id;

  const buf = readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer' });

  let totalInserted = 0;
  for (const spec of NAQEL_SHEETS) {
    const sheet = wb.Sheets[spec.sheetName];
    if (!sheet) {
      console.warn(`  ! sheet '${spec.sheetName}' not found — skipping`);
      continue;
    }
    const rawRows = spec.read(sheet);

    const seen = new Set<string>();
    const rows: SheetRow[] = [];
    let dupCount = 0;
    for (const r of rawRows) {
      if (seen.has(r.source)) {
        dupCount++;
        continue;
      }
      seen.add(r.source);
      rows.push(r);
    }
    if (dupCount > 0) {
      console.warn(`  ! ${spec.type}: dropped ${dupCount} duplicate rows`);
    }

    if (spec.scope === 'universal') {
      // Upsert into tabadul_codes — universal data, no operator scope.
      await db()
        .delete(tabadulCodes)
        .where(eq(tabadulCodes.codeType, spec.type));
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        await db().insert(tabadulCodes).values(
          slice.map((r) => ({
            codeType: spec.type,
            sourceValue: r.source,
            canonicalValue: r.canonical,
            metadata: r.metadata,
          })),
        );
      }
      console.log(`  tabadul_codes    ${spec.type.padEnd(28)} ${rows.length} rows`);
    } else {
      // Operator-scoped — replace just (operator_id, lookup_type).
      await db()
        .delete(operatorLookups)
        .where(and(eq(operatorLookups.operatorId, operatorId), eq(operatorLookups.lookupType, spec.type)));
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        await db().insert(operatorLookups).values(
          slice.map((r) => ({
            operatorId,
            lookupType: spec.type,
            sourceValue: r.source,
            canonicalValue: r.canonical,
            metadata: r.metadata,
          })),
        );
      }
      console.log(`  operator_lookups ${spec.type.padEnd(28)} ${rows.length} rows`);
    }
    totalInserted += rows.length;
  }

  console.log(`Total: ${totalInserted} rows seeded for operator '${operator}'`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
