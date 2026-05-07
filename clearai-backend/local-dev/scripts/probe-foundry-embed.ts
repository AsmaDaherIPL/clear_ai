/**
 * One-shot probe of the Foundry embedder. Verifies:
 *   - the endpoint URL is reachable
 *   - the API key is accepted
 *   - the response shape matches what embedder.ts parses
 *   - the returned vector has FOUNDRY_EMBED_DIM dimensions
 *
 * Prints the first 5 dims of the returned vector so a human can eyeball
 * that the response wasn't a stubbed-zeroes safety reply.
 *
 * Run: pnpm tsx local-dev/scripts/probe-foundry-embed.ts
 */
import { embedQuery } from '../../src/inference/embeddings/embedder.js';
import { env } from '../../src/config/env.js';

async function main(): Promise<void> {
  const e = env();
  console.log('[probe] endpoint:', e.FOUNDRY_EMBED_ENDPOINT);
  console.log('[probe] model:   ', e.FOUNDRY_EMBED_MODEL);
  console.log('[probe] dim:     ', e.FOUNDRY_EMBED_DIM);

  const text = 'two-strap flat slide sandal made entirely of EVA, waterproof';
  console.log('[probe] embedding:', JSON.stringify(text));

  const t0 = Date.now();
  const v = await embedQuery(text);
  const elapsed = Date.now() - t0;

  console.log('[probe] returned', v.length, 'dims in', elapsed, 'ms');
  console.log('[probe] first 5 dims:', v.slice(0, 5));

  if (v.length !== e.FOUNDRY_EMBED_DIM) {
    console.error(
      `[probe] FAIL: expected ${e.FOUNDRY_EMBED_DIM} dims, got ${v.length}`,
    );
    process.exit(1);
  }
  console.log('[probe] OK');
}

main().catch((err) => {
  console.error('[probe] FAIL:', err);
  process.exit(1);
});
