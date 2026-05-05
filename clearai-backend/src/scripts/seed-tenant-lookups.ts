/**
 * Seed tenant_lookups from Naqel's mapping xlsx.
 *
 * Source:
 *   naqel-shared-data/Naqel (Fields details + Mapping data).xlsx
 *
 * Each sheet maps to a lookup_type:
 *   CityMaping                       -> 'consignee_city'
 *   Tabdul City                      -> 'tabadul_city'
 *   CurrencyMapping                  -> 'currency_code'
 *   SourceCompanyPortMaping          -> 'source_port_code'
 *   Tabadul CountryCode              -> 'country_of_origin'
 *   CountryOfOriginClientMapping     -> 'country_of_origin_client'
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

interface SheetSpec {
  /** Verbatim sheet name in the xlsx. */
  sheetName: string;
  /** lookup_type to write into tenant_lookups. */
  lookupType: string;
  /** Header (row 1) name of the source column. */
  sourceColumn: string;
  /** Header (row 1) name of the canonical column. */
  canonicalColumn: string;
}

const NAQEL_SHEETS: ReadonlyArray<SheetSpec> = [
  { sheetName: 'CityMaping', lookupType: 'consignee_city', sourceColumn: 'Source', canonicalColumn: 'Canonical' },
  { sheetName: 'Tabdul City', lookupType: 'tabadul_city', sourceColumn: 'Source', canonicalColumn: 'Canonical' },
  { sheetName: 'CurrencyMapping', lookupType: 'currency_code', sourceColumn: 'Source', canonicalColumn: 'Canonical' },
  { sheetName: 'SourceCompanyPortMaping', lookupType: 'source_port_code', sourceColumn: 'Source', canonicalColumn: 'Canonical' },
  { sheetName: 'Tabadul CountryCode', lookupType: 'country_of_origin', sourceColumn: 'Source', canonicalColumn: 'Canonical' },
  { sheetName: 'CountryOfOriginClientMapping', lookupType: 'country_of_origin_client', sourceColumn: 'Source', canonicalColumn: 'Canonical' },
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

interface LookupRow {
  source: string;
  canonical: string;
}

function readSheet(workbook: XLSX.WorkBook, spec: SheetSpec): LookupRow[] {
  const sheet = workbook.Sheets[spec.sheetName];
  if (!sheet) {
    console.warn(`  ! sheet '${spec.sheetName}' not found — skipping`);
    return [];
  }
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  const out: LookupRow[] = [];
  for (const row of json) {
    const sourceRaw = row[spec.sourceColumn];
    const canonicalRaw = row[spec.canonicalColumn];
    if (sourceRaw === undefined || canonicalRaw === undefined) continue;
    const source = String(sourceRaw).trim();
    const canonical = String(canonicalRaw).trim();
    if (source === '' || canonical === '') continue;
    out.push({ source, canonical });
  }
  return out;
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
    const rows = readSheet(wb, spec);
    // Replace just (tenant, lookup_type) — leave other types untouched.
    await db()
      .delete(tenantLookups)
      .where(and(eq(tenantLookups.tenant, tenant), eq(tenantLookups.lookupType, spec.lookupType)));
    for (const r of rows) {
      await db().insert(tenantLookups).values({
        tenant,
        lookupType: spec.lookupType,
        sourceValue: r.source,
        canonicalValue: r.canonical,
      });
      totalInserted++;
    }
    console.log(`  ${spec.lookupType.padEnd(28)} ${rows.length} rows`);
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
