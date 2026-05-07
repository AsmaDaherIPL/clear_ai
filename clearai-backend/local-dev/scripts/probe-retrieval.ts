/**
 * Quick retrieval probe — runs three known-failing queries through the
 * full hybrid retrieval (vector + BM25 + trigram, weighted RRF) and
 * prints the top 5 candidates per query so a human can eyeball whether
 * the embedder swap actually moved the needle.
 *
 * Run: pnpm tsx local-dev/scripts/probe-retrieval.ts
 */
import { retrieveCandidates } from '../../src/inference/retrieval/retrieve.js';
import { closeDb } from '../../src/db/client.js';

const QUERIES = [
  "men's long-sleeve t-shirt",
  'two-strap flat slide sandal made entirely of EVA, waterproof',
  'leather sandal with adjustable straps',
];

async function main(): Promise<void> {
  for (const q of QUERIES) {
    console.log('\n=== query:', JSON.stringify(q));
    const t0 = Date.now();
    const cands = await retrieveCandidates(q);
    const elapsed = Date.now() - t0;
    console.log(`(${cands.length} candidates in ${elapsed}ms)`);
    for (const c of cands.slice(0, 5)) {
      const desc = (c.description_en ?? '').slice(0, 60);
      console.log(
        `  ${c.code}  rrf=${c.rrf_score.toFixed(4)}  vec=${c.vec_score?.toFixed(3)}  ${desc}`,
      );
    }
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
