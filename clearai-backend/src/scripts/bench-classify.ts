/**
 * Latency benchmark for /classifications.
 *
 * Sequentially fires N requests against a chosen base URL and reports:
 *   - per-call total latency, decision_status, decision_reason, chosen_code
 *   - which LLM stages fired (from response.modelCalls — emitted by H1
 *     aggregator) plus their individual latencies
 *   - aggregates: p50, p95, max, mean
 *
 * Usage:
 *   pnpm tsx src/scripts/bench-classify.ts \
 *     [--base http://localhost:3000] \
 *     [--apim-key <key>]              \
 *     [--n 15]                        \
 *     [--inputs path/to/inputs.json]
 *
 * Defaults:
 *   --base       http://localhost:3000  (no APIM key needed)
 *   --n          15
 *   inputs       INPUTS constant below — a representative product set
 *
 * To benchmark Azure through APIM:
 *   pnpm tsx src/scripts/bench-classify.ts \
 *     --base https://apim-infp-clearai-be-dev-gwc-01.azure-api.net \
 *     --apim-key <key>
 *
 * Sequential, not parallel — measures the real-user critical path,
 * not throughput under burst.
 */

interface ModelCallTrace {
  model: string;
  latency_ms: number;
  stage: string;
  status: string;
}

interface DescribeResponse {
  decision_status: string;
  decision_reason: string;
  confidence_band?: string;
  result?: { code: string };
  request_id?: string;
  model?: { embedder: string; llm: string | null };
  // The route ships these in the *event* payload, not on the response —
  // so we rely on a /trace round-trip below to get the full per-stage
  // breakdown. Keeping the shape loose here.
}

interface TraceResponse {
  model_calls?: ModelCallTrace[];
  total_latency_ms?: number;
}

const DEFAULT_INPUTS = [
  // Clean, recognised — should hit the fast path (cleanup skipped, no researcher)
  'men white shirt',
  'cotton t-shirt',
  'leather wallet',
  'extra virgin olive oil',
  'wireless bluetooth headphones',
  // Slightly noisy — cleanup likely fires, researcher likely skipped
  'Loewe Puzzle bag',
  'Sony WH-1000XM5',
  'Nike Air Max sneakers',
  // Brand/SKU noise — researcher / web research path
  'Samsung Galaxy S25 Ultra',
  'Apple iPhone 16 Pro Max 256GB',
  // Generic with attribute mix
  '1L bottle of cooking oil',
  'kids toy plastic',
  // Arabic
  'قميص قطني للرجال',
  // Edge: short
  'shoes',
  'watch',
];

interface CliArgs {
  base: string;
  apimKey: string | null;
  n: number;
  inputs: string[];
}

function parseArgs(): CliArgs {
  const a = process.argv.slice(2);
  const get = (name: string): string | null => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 && i + 1 < a.length ? (a[i + 1] ?? null) : null;
  };
  const inputsPath = get('inputs');
  const inputs = inputsPath
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      (JSON.parse(require('node:fs').readFileSync(inputsPath, 'utf8')) as string[])
    : DEFAULT_INPUTS;
  const n = Number(get('n') ?? '15');
  return {
    base: (get('base') ?? 'http://localhost:3000').replace(/\/$/, ''),
    apimKey: get('apim-key'),
    n: Number.isFinite(n) && n > 0 ? n : 15,
    inputs: inputs.slice(0, n).concat(
      // Cycle inputs if N > inputs.length
      Array.from({ length: Math.max(0, n - inputs.length) }, (_, i) => inputs[i % inputs.length]!),
    ),
  };
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

interface CallResult {
  description: string;
  totalMs: number;
  decisionStatus: string;
  decisionReason: string;
  chosenCode: string | null;
  requestId: string | null;
  stages: ModelCallTrace[];
  error: string | null;
}

async function callDescribe(args: CliArgs, description: string): Promise<CallResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (args.apimKey) headers['Ocp-Apim-Subscription-Key'] = args.apimKey;

  const t0 = Date.now();
  let body: DescribeResponse | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(`${args.base}/classifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ description }),
    });
    if (!res.ok) {
      error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } else {
      body = (await res.json()) as DescribeResponse;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const totalMs = Date.now() - t0;

  // Pull per-stage breakdown via /trace — only available locally; APIM
  // doesn't expose /trace publicly, so this is best-effort.
  let stages: ModelCallTrace[] = [];
  if (body?.request_id) {
    try {
      const traceRes = await fetch(`${args.base}/trace/${body.request_id}`, { headers });
      if (traceRes.ok) {
        const trace = (await traceRes.json()) as TraceResponse;
        stages = trace.model_calls ?? [];
      }
    } catch {
      // ignore — stages stays empty, total latency is still useful
    }
  }

  return {
    description,
    totalMs,
    decisionStatus: body?.decision_status ?? '—',
    decisionReason: body?.decision_reason ?? '—',
    chosenCode: body?.result?.code ?? null,
    requestId: body?.request_id ?? null,
    stages,
    error,
  };
}

function fmt(n: number): string {
  return `${n.toFixed(0).padStart(5)}ms`;
}

function printRow(i: number, r: CallResult): void {
  const code = r.chosenCode ?? '—'.padEnd(12);
  const stages =
    r.stages.length > 0
      ? r.stages.map((s) => `${s.stage}=${s.latency_ms}ms`).join(' · ')
      : r.error ?? '(no trace)';
  // eslint-disable-next-line no-console
  console.log(
    `  ${String(i + 1).padStart(2)}. ${fmt(r.totalMs)}  ${r.decisionStatus.padEnd(20)} ${code}  ${r.description.slice(0, 32).padEnd(32)}  ${stages}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs();

  // eslint-disable-next-line no-console
  console.log(
    `\nBenchmarking ${args.n} calls against ${args.base}\n` +
      `(${args.apimKey ? 'APIM-keyed' : 'no APIM key — local or backend-direct'})\n` +
      `\n  #   total      decision             code          input                              stages`,
  );
  // eslint-disable-next-line no-console
  console.log('  ' + '─'.repeat(150));

  const results: CallResult[] = [];
  for (let i = 0; i < args.n; i++) {
    const r = await callDescribe(args, args.inputs[i]!);
    results.push(r);
    printRow(i, r);
  }

  // Aggregates
  const lats = results.map((r) => r.totalMs);
  const errors = results.filter((r) => r.error).length;

  // Per-stage aggregation
  const stageTotals = new Map<string, number[]>();
  for (const r of results) {
    for (const s of r.stages) {
      if (!stageTotals.has(s.stage)) stageTotals.set(s.stage, []);
      stageTotals.get(s.stage)!.push(s.latency_ms);
    }
  }

  // eslint-disable-next-line no-console
  console.log('\n  ─── totals ─────────────────────────────────────────────');
  // eslint-disable-next-line no-console
  console.log(`    p50         ${fmt(pct(lats, 50))}`);
  // eslint-disable-next-line no-console
  console.log(`    p95         ${fmt(pct(lats, 95))}`);
  // eslint-disable-next-line no-console
  console.log(`    max         ${fmt(Math.max(...lats))}`);
  // eslint-disable-next-line no-console
  console.log(`    mean        ${fmt(lats.reduce((a, b) => a + b, 0) / lats.length)}`);
  // eslint-disable-next-line no-console
  console.log(`    errors      ${errors}/${results.length}`);

  if (stageTotals.size > 0) {
    // eslint-disable-next-line no-console
    console.log('\n  ─── per-stage (across calls that fired the stage) ──────');
    for (const [stage, vs] of [...stageTotals.entries()].sort()) {
      // eslint-disable-next-line no-console
      console.log(
        `    ${stage.padEnd(20)} fired ${String(vs.length).padStart(2)}/${args.n}  p50=${fmt(pct(vs, 50))} p95=${fmt(pct(vs, 95))}`,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log('\n  ─── decision distribution ──────────────────────────────');
  const dist = new Map<string, number>();
  for (const r of results) dist.set(r.decisionStatus, (dist.get(r.decisionStatus) ?? 0) + 1);
  for (const [k, v] of [...dist.entries()].sort()) {
    // eslint-disable-next-line no-console
    console.log(`    ${k.padEnd(24)} ${v}/${args.n}`);
  }
  // eslint-disable-next-line no-console
  console.log('');
}

void main();
export {};
