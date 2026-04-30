/**
 * Latency + correctness check for /classifications/expand.
 *
 * Runs a fixed set of (parent_code, description) pairs that cover the
 * different paths the expand handler can take:
 *   - broker-mapping hit
 *   - 4-digit heading parent (post-fix)
 *   - 6-digit subheading parent
 *   - 10-digit narrow parent
 *   - non-existent parent
 *   - single-descendant short-circuit
 *
 * Reports per-call decision + chosen code + which path fired, plus
 * a small aggregate.
 *
 * Usage:
 *   pnpm tsx src/scripts/bench-expand.ts [--base http://localhost:3000]
 */

interface ExpandResponse {
  decision_status: string;
  decision_reason: string;
  confidence_band?: string;
  before?: { code: string };
  after?: {
    code: string;
    description_en: string | null;
    description_ar: string | null;
    retrieval_score: number | null;
  };
  alternatives: Array<{
    code: string;
    description_en: string | null;
    description_ar: string | null;
    retrieval_score: number | null;
  }>;
  rationale?: string;
  broker_mapping?: {
    matched_client_code: string;
    matched_length: number;
    source_row_ref: string | null;
  };
  request_id?: string;
  model?: { embedder: string; llm: string | null };
}

interface TestCase {
  label: string;
  code: string;
  description: string;
  /** Optional expected decision (informative — not asserted). */
  expect?: string;
}

const CASES: TestCase[] = [
  // 4-digit heading parents (only valid after the schema fix)
  { label: '4-digit heading: olive oil → virgin', code: '1509', description: 'olive oil virgin' },
  { label: '4-digit heading: olive oil → extra virgin', code: '1509', description: 'extra virgin olive oil cold pressed' },
  { label: '4-digit heading: shirts → cotton men', code: '6105', description: 'cotton men shirt' },
  { label: '4-digit heading: footwear → leather shoes', code: '6403', description: 'mens leather oxford shoes' },

  // 6-digit subheading parents (always valid)
  { label: '6-digit: olive oil 150930 → virgin', code: '150930', description: 'virgin olive oil' },
  { label: '6-digit: shirts 610510 → cotton', code: '610510', description: 'cotton men shirt long sleeve' },

  // 10-digit narrow parent
  { label: '10-digit narrow: 1509200000', code: '1509200000', description: 'extra virgin olive oil 1L bottle' },

  // Non-existent / weird parent (should return invalid_prefix)
  { label: 'Bad prefix: 9999', code: '9999', description: 'doesnt matter' },

  // A code that may match the broker-mapping table (if seeded)
  { label: 'Possible broker hit: 0102100000', code: '0102100000', description: 'cattle' },
];

interface Result {
  c: TestCase;
  totalMs: number;
  body: ExpandResponse | null;
  error: string | null;
}

async function callExpand(base: string, c: TestCase): Promise<Result> {
  const t0 = Date.now();
  let body: ExpandResponse | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(`${base}/classifications/expand`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: c.code, description: c.description }),
    });
    if (!res.ok) {
      error = `HTTP ${res.status}: ${(await res.text()).slice(0, 250)}`;
    } else {
      body = (await res.json()) as ExpandResponse;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { c, totalMs: Date.now() - t0, body, error };
}

function pathTaken(b: ExpandResponse | null): string {
  if (!b) return '—';
  if (b.broker_mapping) return 'broker_mapping';
  if (b.decision_reason === 'invalid_prefix') return 'invalid_prefix';
  if (b.decision_reason === 'single_valid_descendant') return 'single_descendant';
  if (b.decision_reason === 'strong_match') return 'picker';
  if (b.decision_reason === 'weak_retrieval') return 'gate_fail_weak';
  if (b.decision_reason === 'ambiguous_top_candidates') return 'gate_fail_ambiguous';
  if (b.decision_reason === 'guard_tripped') return 'guard_tripped';
  return b.decision_reason;
}

function fmt(n: number): string {
  return `${n.toFixed(0).padStart(5)}ms`;
}

async function main(): Promise<void> {
  const a = process.argv.slice(2);
  const baseIdx = a.indexOf('--base');
  const base = (baseIdx >= 0 && a[baseIdx + 1] ? a[baseIdx + 1]! : 'http://localhost:3000').replace(
    /\/$/,
    '',
  );

  console.log(`\nTesting /classifications/expand against ${base}\n`);
  console.log(
    '  #   total      decision                   path                  before → after                                top alt',
  );
  console.log('  ' + '─'.repeat(170));

  const results: Result[] = [];
  for (let i = 0; i < CASES.length; i++) {
    const r = await callExpand(base, CASES[i]!);
    results.push(r);
    const path = pathTaken(r.body);
    const before = r.c.code.padEnd(10);
    const after = r.body?.after?.code ?? '—';
    const decision = r.body
      ? `${r.body.decision_status}/${r.body.decision_reason}`.padEnd(28)
      : (r.error?.slice(0, 28) ?? '—'.padEnd(28));
    const topAlt =
      r.body?.alternatives?.[0]?.code ?? r.body?.alternatives?.[1]?.code ?? '—';
    console.log(
      `  ${String(i + 1).padStart(2)}. ${fmt(r.totalMs)}  ${decision}  ${path.padEnd(20)}  ${before} → ${after.padEnd(13)} (${(r.c.description.slice(0, 32)).padEnd(32)})   ${topAlt}`,
    );
  }

  // Aggregate
  console.log('\n  ─── per-case detail ────────────────────────────────────────');
  for (const r of results) {
    console.log(`\n  ◇ ${r.c.label}`);
    console.log(`     input        code=${r.c.code}  description="${r.c.description}"`);
    if (r.error) {
      console.log(`     ERROR        ${r.error}`);
      continue;
    }
    if (!r.body) continue;
    if (r.body.after) {
      console.log(
        `     after        ${r.body.after.code}  ${(r.body.after.description_en ?? '—').slice(0, 80)}`,
      );
    }
    if (r.body.broker_mapping) {
      console.log(
        `     broker hit   client=${r.body.broker_mapping.matched_client_code}  matchedLength=${r.body.broker_mapping.matched_length}  row=${r.body.broker_mapping.source_row_ref ?? '—'}`,
      );
    }
    if (r.body.alternatives.length > 0) {
      console.log(`     top alts:`);
      for (const a of r.body.alternatives.slice(0, 3)) {
        console.log(
          `       · ${a.code}  ${(a.description_en ?? '—').slice(0, 70)}  (rrf=${a.retrieval_score ?? '—'})`,
        );
      }
    }
    if (r.body.rationale) {
      console.log(`     rationale    ${r.body.rationale.slice(0, 200)}`);
    }
  }

  const lats = results.map((r) => r.totalMs).sort((a, b) => a - b);
  const errs = results.filter((r) => r.error).length;
  console.log('\n  ─── totals ─────────────────────────────────────────────');
  console.log(`    cases       ${results.length}`);
  console.log(`    errors      ${errs}`);
  console.log(`    p50         ${fmt(lats[Math.floor(lats.length / 2)] ?? 0)}`);
  console.log(`    p95         ${fmt(lats[Math.floor(lats.length * 0.95)] ?? 0)}`);
  console.log(`    max         ${fmt(lats[lats.length - 1] ?? 0)}`);
  console.log(`    mean        ${fmt(lats.reduce((a, b) => a + b, 0) / Math.max(1, lats.length))}`);
  console.log('');
}

void main();
export {};
