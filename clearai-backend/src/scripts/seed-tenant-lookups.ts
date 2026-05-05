/**
 * Seed tenant_lookups from Naqel's mapping xlsx.
 *
 * Source:
 *   naqel-shared-data/Naqel (Fields details + Mapping data).xlsx
 *
 * Six mapping sheets land as six lookup_types under tenant='naqel':
 *
 *   sheet                          lookup_type            source -> canonical (+ metadata)
 *   ─────────────────────────────  ─────────────────────  ──────────────────────────────────
 *   CurrencyMapping                currency_code          ISO-4217 (e.g. SAR)
 *                                                         -> TabdulCurrencyId (e.g. '100')
 *   Tabadul CountryCode            country_of_origin      INTLCODE (ISO alpha-2, e.g. 'SA')
 *                                                         -> CountryCode (e.g. '145');
 *                                                         metadata: { name, fname }
 *   CountryOfOriginClientMapping   client_country         ClientID -> Countryoforigin (numeric)
 *   SourceCompanyPortMaping        client_source_company  ClientID -> SourceCompanyNo;
 *                                                         metadata: { sourceCompanyName,
 *                                                         custRegPortCode }
 *   CityMaping                     destination_station    InfoCityId (== DestinationStationID)
 *                                                         -> TabdulCityId (the canonical city
 *                                                         code used in the ZATCA envelope)
 *   Tabdul City                    tabdul_city            CITY_CD (Tabdul city id)
 *                                                         -> CITY_ARB_NAME (Arabic city name);
 *                                                         metadata: { engName, intlCode,
 *                                                         countryCode }
 *
 * Hot-path renderer queries:
 *   • currency:        lookup('currency_code', row.currencyCode) -> '100'
 *   • country origin:  lookup('country_of_origin', row.countryOfOrigin) -> '145'
 *   • client default:  lookup('client_country', row.clientId) -> '145'
 *   • source company:  lookup('client_source_company', row.clientId)
 *                        -> { canonical: '383668', metadata: { sourceCompanyName: 'Vogacloset', custRegPortCode: '...' } }
 *   • destination:     city = lookup('destination_station', row.destinationStationId)
 *                      then nameAr = lookup('tabdul_city', city)
 *
 * The composite "destination city -> tabdul city -> Arabic name" is two
 * hops on purpose — the source data ships them as two separate sheets,
 * and the rendering layer composes them at request time.
 *
 * Per-tenant DELETE+re-insert scoped to ('naqel', lookup_type) so re-running
 * is idempotent and other tenants are untouched.
 *
 * Sandbox note: this machine blocks plain readFile on cross-mount paths.
 * We use readFileSync + XLSX.read({type:'buffer'}) to dodge that.
 *
 * Usage:
 *   pnpm db:seed:tenant-lookups
 *   tsx src/scripts/seed-tenant-lookups.ts --file path/to/other.xlsx --tenant aramex
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import * as XLSX from 'xlsx';
import { and, eq } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';
import { tenantLookups } from '../db/schema.js';

interface SheetRow {
  source: string;
  canonical: string;
  metadata: Record<string, unknown>;
}

/** Build a list of (source, canonical, metadata) from one sheet. */
type SheetReader = (sheet: XLSX.WorkSheet) => SheetRow[];

interface SheetSpec {
  sheetName: string;
  lookupType: string;
  read: SheetReader;
}

const NAQEL_SHEETS: ReadonlyArray<SheetSpec> = [
  {
    sheetName: 'CurrencyMapping',
    lookupType: 'currency_code',
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
    lookupType: 'country_of_origin',
    read: (sheet) => {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
      // The sheet contains:
      //   • genuine countries (one row per ISO INTLCODE)
      //   • Saudi customs-gate rows where INTLCODE is a 5-char station code
      //     (e.g. 'SAJED', 'SADAM' — multiple gate facilities under one
      //     prefix) — not country-of-origin data
      //   • bookkeeping rows where INTLCODE is literally 'NULL'
      //
      // We want exactly one canonical mapping per ISO alpha-2 input. Filter
      // to 2-char INTLCODE values, drop 'NULL', keep the first occurrence
      // of each — Tabadul ships the canonical row first.
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
    lookupType: 'client_country',
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
    lookupType: 'client_source_company',
    read: (sheet) => {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
      // Multiple rows can share the same ClientID (one per CustRegPortCode).
      // For v0 we keep ALL rows but de-duplicate by (ClientID, CustRegPortCode)
      // — the natural-key UNIQUE on tenant_lookups is on (tenant,
      // lookup_type, source_value). To honour it, we encode the composite
      // key into source_value: '{ClientID}:{CustRegPortCode}' so every
      // (client, port) combination has its own row. The renderer composes
      // the lookup key the same way.
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
    lookupType: 'destination_station',
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
    lookupType: 'tabdul_city',
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
const DEFAULT_TENANT = 'naqel';

interface Args {
  filePath: string;
  tenant: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let filePath = DEFAULT_NAQEL_PATH;
  let tenant = DEFAULT_TENANT;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file' && args[i + 1]) {
      filePath = resolvePath(args[++i]!);
    } else if (a === '--tenant' && args[i + 1]) {
      tenant = args[++i]!;
    }
  }
  return { filePath, tenant };
}

async function main(): Promise<void> {
  const { filePath, tenant } = parseArgs();

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    console.error(`Place Naqel's mapping workbook at the path above, or pass --file.`);
    process.exit(1);
  }

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

    // Defence-in-depth dedup: the natural-key UNIQUE on tenant_lookups is
    // (tenant, lookup_type, source_value). Source xlsx sheets occasionally
    // ship duplicate rows; keep the first occurrence and warn.
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
      console.warn(`  ! ${spec.lookupType}: dropped ${dupCount} duplicate rows`);
    }

    // Replace just (tenant, lookup_type) — leave other types untouched.
    await db()
      .delete(tenantLookups)
      .where(and(eq(tenantLookups.tenant, tenant), eq(tenantLookups.lookupType, spec.lookupType)));

    // Bulk insert with chunking for large sheets (Tabdul City ~2168 rows).
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      await db().insert(tenantLookups).values(
        slice.map((r) => ({
          tenant,
          lookupType: spec.lookupType,
          sourceValue: r.source,
          canonicalValue: r.canonical,
          metadata: r.metadata,
        })),
      );
    }
    console.log(`  ${spec.lookupType.padEnd(28)} ${rows.length} rows`);
    totalInserted += rows.length;
  }

  console.log(`Total: ${totalInserted} rows inserted under tenant '${tenant}'`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
