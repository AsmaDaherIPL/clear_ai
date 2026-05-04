# ClearAI evaluation suite

A frozen, version-controlled set of 500 broker invoice rows used to measure
whether pipeline changes (embedder swaps, prompt edits, retrieval rewrites)
actually move accuracy.

## Why this exists

Without an eval set, every pipeline change is judged by spot-checking 5–15
manual cURL tests. That's not enough signal — small samples lie. With this
suite you get one number out (`heading-or-better: 87.9%`) that you can
compare across runs to make decisions like "should we swap the embedder?"
or "did dropping the chapter hint help or hurt?"

## Files

```
eval/
├── README.md                  ← you are here
├── data/
│   └── broker-invoices-v1.jsonl   ← 500 rows; committed; never edited in place
├── results/
│   └── YYYY-MM-DD-<tag>.json      ← committed snapshots of each eval run
└── (scripts live in src/scripts/eval-*.ts)
```

The data file is **append-only across versions** — if you need different
samples, sample a new file (`v2.jsonl`) and keep `v1.jsonl` for history.

## How rows were sampled

Source: `naqel-shared-data/client_commercial_invoices_sample2_anonymized.xlsx`,
column A (description) + column B (broker's HS code). 100,000-row distribution
survey showed the workload is overwhelmingly short English nouns:

| Length | % of traffic | Bucket size in v1 |
|---|---|---|
| 1 word                 | 29.7%       | 150 rows |
| 2 words                | 55.9%       | 250 rows |
| 3 words                | 12.9%       |  75 rows |
| 4+ words               |  1.4%       |  25 rows |
| **Total**              | **100%**    | **500 rows** |

Stratified random sampling within each bucket; `random.seed(42)` for
reproducibility.

Arabic and brand/SKU inputs are NOT represented in this broker's invoice
data (0 of 100k rows). When we add Arabic-heavy or SKU-heavy broker
clients, we sample a v2 with their distribution.

## Row schema (`data/broker-invoices-v1.jsonl`)

One JSON object per line:

```jsonc
{
  "id": 1,                                        // 1..500, stable
  "description": "Hair Clip",                     // col A from xlsx
  "broker_code": "961511000004",                  // col B from xlsx
  "broker_chapter": "96",                         // first 2 of broker_code
  "broker_heading": "9615",                       // first 4 of broker_code
  "length_bucket": "len_2",                       // len_1 / len_2 / len_3 / len_4plus
  "quality": "default" | "broker_likely_wrong"    // see below
}
```

`quality` is `"default"` for every row at the v1 commit. After running an
eval and reviewing failures, rows where the broker label is clearly wrong
(e.g. eyelash brush coded as a vacuum cleaner) get bumped to
`"broker_likely_wrong"` in a follow-up commit. Those rows are EXCLUDED
from the headline accuracy number but included in the raw-results file.

## How to run

```bash
# 1. Make sure backend is running
pnpm dev

# 2. In another shell:
pnpm eval                                # runs all 500 rows, ~20 min, ~$4
pnpm eval --limit 50                     # smoke test a smaller slice
pnpm eval --tag bge-m3-test              # results saved as YYYY-MM-DD-bge-m3-test.json
```

## How to interpret the output

```
═══════════════════════════════════════════════════════════════
  Total tests:                                            500
  Excluded (broker_likely_wrong):                          12
  Effective denominator:                                  488
─────────────────────────────────────────────────────────────
  ✓ Exact 12-digit match:                       183 (37.5%)
  ~ Heading match (first 4 digits):             246 (50.4%)
  ~ Chapter only (first 2 digits):               34  (7.0%)
  ✗ Wrong chapter or no code:                    25  (5.1%)
─────────────────────────────────────────────────────────────
  Heading-or-better:                            429 (87.9%)   ← THE NUMBER
```

**Heading-or-better is the headline metric.** Brokers can refine within a
heading via `/expand`; below heading they have to start over. Track this
single number across runs.

## Adding to the suite

- **Don't edit `v1.jsonl` in place** — create v2 if the sample needs to change.
- **Do annotate quality** by editing `quality: "broker_likely_wrong"` for
  obvious-error rows, with a `notes:` field explaining why. Commit the change.
- **Don't make the eval flaky** — the LLM picker IS slightly nondeterministic
  due to temperature, but Sonnet at temperature 0 (current setting) is
  stable enough for ±1-2 percentage points run-to-run. Larger swings mean
  a real change.
