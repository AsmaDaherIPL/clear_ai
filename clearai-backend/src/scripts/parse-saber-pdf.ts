/**
 * One-shot dev tool: parse a SABER platform "deleted HS codes" PDF and emit
 * data/saber-deleted-codes.csv.
 *
 * Usage:
 *   npx tsx src/scripts/parse-saber-pdf.ts <path-to-pdf>
 *
 * Re-run whenever SABER publishes a new deletion notification PDF. Commit the
 * updated CSV, then run pnpm db:seed:deleted to apply the changes to the DB.
 * For production, also add a new inline-seed migration (following the
 * 0022_hs_codes_deletion_seed.sql pattern) so Container App deploys pick it
 * up automatically.
 *
 * ── How the PDF is structured ───────────────────────────────────────────────
 * Pages 1-N may contain "subject to technical regulations" sections — these
 * duplicate what we already surface as result.procedures and are OUT OF SCOPE.
 * Those pages are identified by NOT containing the heading "DELETED H.S CODES".
 *
 * Deleted-code pages contain a two-column table:
 *   Left column:  deleted 12-digit HS code (always ends in 000000 in practice)
 *   Right column: one or more alternative 12-digit codes
 *
 * Between groups of deleted codes, date headers appear:
 *   "The HS Codes below will be replaced on Saber Platform, starting (YYYY-MM-DD)"
 *
 * ── Parsing strategy ────────────────────────────────────────────────────────
 * We rely on the structural invariant that the left-column "deleted" codes
 * always end in 000000 (they are generic leaf nodes being split into more-
 * specific children). Each 000000-ending code found in the text starts a new
 * group; all subsequent non-000000 codes belong to that group as alternatives
 * until the next 000000 code is encountered.
 *
 * This works because alternative codes use SABER-specific suffixes
 * (000001, 000002, ..., 009999) that are distinct from the 000000 pattern.
 *
 * Requires: pypdf installed in the system Python3.
 * Install: pip3 install pypdf
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('Usage: npx tsx src/scripts/parse-saber-pdf.ts <path-to-pdf>');
  process.exit(1);
}

const OUT_CSV = join(process.cwd(), 'data', 'saber-deleted-codes.csv');

// Run a Python script inline via execSync (keeps us from needing a separate
// .py file or a Node PDF library that understands Arabic-mixed PDFs).
const pythonScript = `
import pypdf, re, json, csv, sys
from io import StringIO

path = ${JSON.stringify(pdfPath)}
reader = pypdf.PdfReader(path)
pages = [reader.pages[i].extract_text() for i in range(len(reader.pages))]

DATE_RE = re.compile(r'(\\d{4}-\\d{2}-\\d{2})')
CODE_RE = re.compile(r'\\b(\\d{12})\\b')

sections = []
current_date = None
current_codes = []

for i, page_text in enumerate(pages):
    # Skip pages that have NO "DELETED H.S CODES" heading AND no prior deleted
    # date context yet — these are the "subject to technical regulations" pages
    # (out of scope). Once we've found the first deletion date we stop skipping.
    if current_date is None and 'DELETED H.S CODES' not in page_text and i < 3:
        continue

    dates = DATE_RE.findall(page_text)
    codes = CODE_RE.findall(page_text)

    if dates:
        if current_codes:
            sections.append((current_date, current_codes))
        current_date = dates[0]
        current_codes = list(codes)
    else:
        current_codes.extend(codes)

if current_codes:
    sections.append((current_date, current_codes))

records = []
for eff_date, codes in sections:
    i = 0
    while i < len(codes):
        code = codes[i]
        if code.endswith('000000'):
            deleted_code = code
            alts = []
            j = i + 1
            while j < len(codes) and not codes[j].endswith('000000'):
                alts.append(codes[j])
                j += 1
            records.append((deleted_code, eff_date, json.dumps(alts)))
            i = j
        else:
            i += 1

out = StringIO()
writer = csv.writer(out)
writer.writerow(['deleted_code', 'effective_date', 'replacement_codes'])
for r in records:
    writer.writerow(r)
print(out.getvalue(), end='')
sys.stdout.flush()
`;

// eslint-disable-next-line no-console
console.log(`Parsing ${pdfPath} ...`);

let csvContent: string;
try {
  csvContent = execSync(`python3 -c ${JSON.stringify(pythonScript)}`, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('Python parsing failed:', err);
  // eslint-disable-next-line no-console
  console.error('Ensure pypdf is installed: pip3 install pypdf');
  process.exit(1);
}

const rows = csvContent.trim().split('\n').length - 1; // subtract header
writeFileSync(OUT_CSV, csvContent, 'utf8');

// eslint-disable-next-line no-console
console.log(`✓ Wrote ${rows} deleted-code records to ${OUT_CSV}`);
// eslint-disable-next-line no-console
console.log('Next steps:');
// eslint-disable-next-line no-console
console.log('  1. Review data/saber-deleted-codes.csv');
// eslint-disable-next-line no-console
console.log('  2. pnpm db:seed:deleted    (update local DB)');
// eslint-disable-next-line no-console
console.log('  3. Add a new 00NN_hs_codes_deletion_seedN.sql migration for prod');
