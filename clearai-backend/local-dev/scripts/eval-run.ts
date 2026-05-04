/**
 * eval-run.ts — runs the broker-invoice eval set against a live backend
 * and writes a results snapshot.
 *
 * Run:
 *   pnpm dev       # in another shell
 *   pnpm eval                            # full 500-row run, ~20 min, ~$4
 *   pnpm eval --limit 50                 # smoke test
 *   pnpm eval --tag bge-m3-experiment    # results saved as YYYY-MM-DD-bge-m3-experiment.json
 *   pnpm eval --base http://localhost:3000 --concurrency 4
 *
 * Output: eval/results/YYYY-MM-DD-<tag>.json + a stdout summary.
 *
 * The script never hits the LLM directly — it just POSTs to /classifications
 * and reads the response. So it tests the WHOLE pipeline as a black box,
 * which is the right thing to test.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

interface EvalRow {
  id: number;
  description: string;
  broker_code: string;
  broker_chapter: string;
  broker_heading: string;
  length_bucket: 'len_1' | 'len_2' | 'len_3' | 'len_4plus';
  quality: 'default' | 'broker_likely_wrong';
  notes?: string;
}

type MatchKind = 'exact' | 'heading' | 'chapter' | 'wrong' | 'no_code';

interface CaseResult {
  id: number;
  description: string;
  length_bucket: EvalRow['length_bucket'];
  quality: EvalRow['quality'];
  broker_code: string;
  ai_code: string | null;
  decision_status: string | null;
  decision_reason: string | null;
  needs_review: boolean;
  match: MatchKind;
  latency_ms: number;
  request_id: string | null;
  error?: string;
}

interface RunArgs {
  base: string;
  dataPath: string;
  outDir: string;
  tag: string;
  limit: number | null;
  /**
   * Stratified sample size. When set, replaces the in-order `--limit` slice
   * with a proportional random sample across all length_bucket values, so a
   * 100-row sample reflects the same 30/50/15/5 mix as the full set rather
   * than collapsing to a single bucket.
   *
   * Mutually exclusive with --limit; --stratified-sample wins if both are set.
   * Deterministic — uses a fixed seeded shuffle so back-to-back runs use the
   * same row IDs (essential for A/B comparisons).
   */
  stratifiedSample: number | null;
  concurrency: number;
}

function parseArgs(argv: string[]): RunArgs {
  const args: Partial<RunArgs> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--base' && argv[i + 1]) args.base = argv[++i];
    else if (a === '--data' && argv[i + 1]) args.dataPath = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.outDir = argv[++i];
    else if (a === '--tag' && argv[i + 1]) args.tag = argv[++i];
    else if (a === '--limit' && argv[i + 1]) args.limit = Number(argv[++i]);
    else if (a === '--stratified-sample' && argv[i + 1]) args.stratifiedSample = Number(argv[++i]);
    else if (a === '--concurrency' && argv[i + 1]) args.concurrency = Number(argv[++i]);
  }
  return {
    base: args.base ?? 'http://localhost:3000',
    dataPath: args.dataPath ?? 'local-dev/eval/data/broker-invoices-v1.jsonl',
    outDir: args.outDir ?? 'local-dev/eval/results',
    tag: args.tag ?? 'baseline',
    limit: args.limit ?? null,
    stratifiedSample: args.stratifiedSample ?? null,
    // Default concurrency 2 — Anthropic's tier-1 rate-limits choke at 4+
    // for our token sizes. Bump only if you've upgraded the API tier.
    concurrency: Math.max(1, Math.min(16, args.concurrency ?? 2)),
  };
}

/**
 * Mulberry32 — small deterministic PRNG. Same seed → same sequence across runs.
 * Plenty good enough for sampling row indices; not for crypto.
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Proportional stratified sample: pick `target` rows total, sized per
 * length_bucket so the sample mirrors the source distribution.
 *
 * Seed fixed to 42 (matches build-eval-set.py) so re-runs sample the same
 * IDs — A/B comparisons need identical row sets across runs.
 */
function stratifiedSample(rows: EvalRow[], target: number): EvalRow[] {
  const buckets: Record<string, EvalRow[]> = {};
  for (const r of rows) {
    if (!buckets[r.length_bucket]) buckets[r.length_bucket] = [];
    buckets[r.length_bucket]!.push(r);
  }
  const total = rows.length;
  const rand = mulberry32(42);
  const out: EvalRow[] = [];
  for (const [bucket, pool] of Object.entries(buckets)) {
    const want = Math.max(1, Math.round((pool.length / total) * target));
    // Fisher-Yates shuffle (in-place on a copy), then take first `want`.
    const copy = pool.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    const slice = copy.slice(0, Math.min(want, copy.length));
    console.log(`  stratified-sample: ${bucket} → ${slice.length} of ${pool.length} (target ~${want})`);
    out.push(...slice);
  }
  // Sort by id for stable ordering across runs (concurrency interleaves anyway,
  // but stable input order keeps the saved results JSON byte-stable when
  // results land in the same order).
  out.sort((a, b) => a.id - b.id);
  return out;
}

function classify(brokerCode: string, aiCode: string | null): MatchKind {
  if (!aiCode) return 'no_code';
  if (aiCode === brokerCode) return 'exact';
  if (aiCode.length >= 4 && brokerCode.length >= 4 && aiCode.slice(0, 4) === brokerCode.slice(0, 4))
    return 'heading';
  if (aiCode.length >= 2 && brokerCode.length >= 2 && aiCode.slice(0, 2) === brokerCode.slice(0, 2))
    return 'chapter';
  return 'wrong';
}

async function classifyOne(base: string, row: EvalRow): Promise<CaseResult> {
  const t0 = Date.now();
  const url = `${base}/classifications`;
  // Retry-with-backoff on 429 (Anthropic rate-limit). Up to 3 attempts.
  let resp: Response | null = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: row.description }),
        signal: AbortSignal.timeout(60_000),
      });
      lastStatus = resp.status;
      if (resp.status === 429) {
        // Exponential backoff: 5s, 12s, 25s. Drains the rate-limit window.
        const backoffMs = [5_000, 12_000, 25_000][attempt] ?? 25_000;
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      break;
    } catch (err) {
      return {
        id: row.id,
        description: row.description,
        length_bucket: row.length_bucket,
        quality: row.quality,
        broker_code: row.broker_code,
        ai_code: null,
        decision_status: null,
        decision_reason: null,
        needs_review: false,
        match: 'no_code',
        latency_ms: Date.now() - t0,
        request_id: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  try {
    if (!resp) throw new Error('no response after retries');
    const latency_ms = Date.now() - t0;
    if (!resp.ok) {
      return {
        id: row.id,
        description: row.description,
        length_bucket: row.length_bucket,
        quality: row.quality,
        broker_code: row.broker_code,
        ai_code: null,
        decision_status: null,
        decision_reason: null,
        needs_review: false,
        match: 'no_code',
        latency_ms,
        request_id: null,
        error: `HTTP ${lastStatus}`,
      };
    }
    const body = (await resp.json()) as {
      request_id?: string;
      decision_status?: string;
      decision_reason?: string;
      needs_review?: boolean;
      result?: { code?: string };
    };
    const aiCode = body.result?.code ?? null;
    return {
      id: row.id,
      description: row.description,
      length_bucket: row.length_bucket,
      quality: row.quality,
      broker_code: row.broker_code,
      ai_code: aiCode,
      decision_status: body.decision_status ?? null,
      decision_reason: body.decision_reason ?? null,
      needs_review: body.needs_review === true,
      match: classify(row.broker_code, aiCode),
      latency_ms,
      request_id: body.request_id ?? null,
    };
  } catch (err) {
    return {
      id: row.id,
      description: row.description,
      length_bucket: row.length_bucket,
      quality: row.quality,
      broker_code: row.broker_code,
      ai_code: null,
      decision_status: null,
      decision_reason: null,
      needs_review: false,
      match: 'no_code',
      latency_ms: Date.now() - t0,
      request_id: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runWithConcurrency(rows: EvalRow[], base: string, concurrency: number): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(rows.length);
  let nextIdx = 0;
  let done = 0;
  const total = rows.length;
  const t0 = Date.now();

  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= rows.length) return;
      const result = await classifyOne(base, rows[idx]!);
      results[idx] = result;
      done++;
      if (done % 10 === 0 || done === total) {
        const elapsed_s = (Date.now() - t0) / 1000;
        const rate = done / elapsed_s;
        const eta_s = (total - done) / Math.max(rate, 0.01);
        process.stdout.write(`\r  ${done}/${total}   ${elapsed_s.toFixed(0)}s elapsed, ETA ${eta_s.toFixed(0)}s   `);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.stdout.write('\n');
  return results;
}

interface BucketStats {
  total: number;
  exact: number;
  heading: number;
  chapter: number;
  wrong: number;
  no_code: number;
}

function emptyStats(): BucketStats {
  return { total: 0, exact: 0, heading: 0, chapter: 0, wrong: 0, no_code: 0 };
}

function tally(results: CaseResult[]): { overall: BucketStats; byBucket: Record<string, BucketStats> } {
  const overall = emptyStats();
  const byBucket: Record<string, BucketStats> = {};
  for (const r of results) {
    if (r.quality === 'broker_likely_wrong') continue;
    overall.total++;
    overall[r.match]++;
    if (!byBucket[r.length_bucket]) byBucket[r.length_bucket] = emptyStats();
    byBucket[r.length_bucket]!.total++;
    byBucket[r.length_bucket]![r.match]++;
  }
  return { overall, byBucket };
}

function pct(n: number, d: number): string {
  if (d === 0) return '  0.0%';
  return `${(100 * n / d).toFixed(1).padStart(5)}%`;
}

function printSummary(results: CaseResult[], excluded: number, totalRows: number): void {
  const { overall, byBucket } = tally(results);
  const headingOrBetter = overall.exact + overall.heading;
  const chapterOrBetter = headingOrBetter + overall.chapter;
  const latencies = results.filter((r) => !r.error).map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
  const errors = results.filter((r) => r.error).length;

  console.log('\n' + '═'.repeat(63));
  console.log(`  Total tests:                                ${totalRows.toString().padStart(10)}`);
  console.log(`  Excluded (broker_likely_wrong):             ${excluded.toString().padStart(10)}`);
  console.log(`  Effective denominator:                      ${overall.total.toString().padStart(10)}`);
  console.log('  ' + '─'.repeat(59));
  console.log(`  ✓ Exact 12-digit match:           ${overall.exact.toString().padStart(4)} (${pct(overall.exact, overall.total)})`);
  console.log(`  ~ Heading match (first 4):        ${overall.heading.toString().padStart(4)} (${pct(overall.heading, overall.total)})`);
  console.log(`  ~ Chapter only (first 2):         ${overall.chapter.toString().padStart(4)} (${pct(overall.chapter, overall.total)})`);
  console.log(`  ✗ Wrong chapter:                  ${overall.wrong.toString().padStart(4)} (${pct(overall.wrong, overall.total)})`);
  console.log(`  ✗ No code returned / error:       ${overall.no_code.toString().padStart(4)} (${pct(overall.no_code, overall.total)})`);
  console.log('  ' + '─'.repeat(59));
  console.log(`  Heading-or-better:                ${headingOrBetter.toString().padStart(4)} (${pct(headingOrBetter, overall.total)})   ← THE NUMBER`);
  console.log(`  Chapter-or-better:                ${chapterOrBetter.toString().padStart(4)} (${pct(chapterOrBetter, overall.total)})`);
  console.log('═'.repeat(63));
  console.log('\nBy length bucket (heading-or-better):');
  const order = ['len_1', 'len_2', 'len_3', 'len_4plus'];
  for (const k of order) {
    const s = byBucket[k];
    if (!s) continue;
    const hb = s.exact + s.heading;
    console.log(`  ${k.padEnd(10)}  ${s.total.toString().padStart(4)} rows   ${hb.toString().padStart(4)} hb (${pct(hb, s.total)})`);
  }
  console.log(`\nLatency: p50=${p50}ms · p95=${p95}ms · p99=${p99}ms`);
  if (errors > 0) console.log(`Network/HTTP errors: ${errors}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(`Eval config:`);
  console.log(`  base:        ${args.base}`);
  console.log(`  data:        ${args.dataPath}`);
  console.log(`  tag:         ${args.tag}`);
  console.log(`  limit:       ${args.limit ?? '(all)'}`);
  console.log(`  stratified:  ${args.stratifiedSample ?? '(off)'}`);
  console.log(`  concurrency: ${args.concurrency}`);

  // Load eval rows
  const raw = await readFile(args.dataPath, 'utf8');
  let rows: EvalRow[] = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalRow);
  if (args.stratifiedSample) {
    console.log(`\nStratified sampling ${args.stratifiedSample} rows (seed=42, deterministic):`);
    rows = stratifiedSample(rows, args.stratifiedSample);
  } else if (args.limit) {
    rows.length = Math.min(rows.length, args.limit);
  }

  console.log(`\nRunning ${rows.length} rows against ${args.base}/classifications …`);
  const results = await runWithConcurrency(rows, args.base, args.concurrency);

  // Stats + report
  const excluded = rows.filter((r) => r.quality === 'broker_likely_wrong').length;
  printSummary(results, excluded, rows.length);

  // Persist
  await mkdir(args.outDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const outPath = resolve(args.outDir, `${dateStr}-${args.tag}.json`);
  const payload = {
    meta: {
      timestamp: new Date().toISOString(),
      base: args.base,
      data_path: args.dataPath,
      tag: args.tag,
      total_rows: rows.length,
      excluded: excluded,
    },
    summary: tally(results),
    results,
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${outPath}`);

  // Failure samples — first 10 wrong-chapter cases for inspection
  const wrongs = results.filter((r) => r.match === 'wrong' || r.match === 'no_code').slice(0, 10);
  if (wrongs.length > 0) {
    console.log(`\nFirst ${wrongs.length} wrong-chapter / no-code cases (for review):`);
    for (const w of wrongs) {
      const aiCh = w.ai_code?.slice(0, 2) ?? '··';
      const ai = w.ai_code ?? '(none)';
      const brokerCh = w.broker_code.slice(0, 2);
      console.log(`  [${w.length_bucket}] "${w.description.slice(0, 30)}" → broker ${w.broker_code} (ch ${brokerCh})   ai ${ai} (ch ${aiCh})`);
    }
  }
}

void main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// fetch is global in Node 22 — no extra import needed.
