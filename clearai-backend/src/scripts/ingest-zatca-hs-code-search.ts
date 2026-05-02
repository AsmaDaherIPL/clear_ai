/**
 * Build hs_code_search rows from hs_codes + hs_code_display.
 *
 * Idempotent: TRUNCATEs hs_code_search and re-builds. Run AFTER
 * `pnpm db:seed` (xlsx ingest) AND `pnpm db:seed:display`
 * (path/label derivation).
 *
 * What goes into each column:
 *   • embedding_input — `path_en | path_ar`. The full breadcrumb path,
 *     bilingual, joined by a pipe so e5-multilingual sees both languages
 *     in one passage. This is what the dense (vector) arm sees.
 *
 *   • tsv_input_en — deduplicated token bag from path_en. Lowercased,
 *     stopword-stripped, each meaningful token appearing once. Generic
 *     words like "Other" appear at most once per row even if the path
 *     contains them at multiple levels — prevents BM25 from amplifying
 *     them.
 *
 *   • tsv_input_ar — same shape for Arabic. Arabic dedup uses raw token
 *     equality (no stemming — Postgres has no native Arabic stemmer; we
 *     rely on trigram for morphological recall).
 *
 *   • build_version — process.env.BUILD_VERSION || 'dev' so the row
 *     can be traced back to the pipeline that produced it.
 *
 * Deletion handling: hs_code_search no longer carries an is_deleted
 * mirror (dropped in 0030) — retrieval JOINs hs_codes and reads
 * h.is_deleted directly (single source of truth).
 */
import { getPool, closeDb } from '../db/client.js';
import { embedPassageBatch } from '../embeddings/embedder.js';
import { newId } from '../util/uuid.js';

const BATCH_EMBED = 32;
const BATCH_INSERT = 200;
const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small@1.0.0';
const BUILD_VERSION = process.env['BUILD_VERSION'] ?? 'dev';

interface SourceRow {
  code: string;
  path_en: string;
  path_ar: string | null;
}

// Conservative English stopword list — small enough to be obviously safe,
// big enough to cut the most useless tokens. We do NOT strip "of"/"with"
// from the embedder input (passage-level embeddings benefit from
// connective tissue), only from the BM25/trigram token bag.
const EN_STOPWORDS = new Set([
  'a','an','and','or','the','of','for','to','in','on','at','by',
  'with','from','as','is','are','be','been','this','that','these',
  'those','it','its','no','not','than','then','if','so','up','down',
]);

function dedupeTokens(text: string, lang: 'en' | 'ar'): string {
  // Strip punctuation; collapse whitespace; lowercase EN.
  const cleaned = text
    .replace(/[>|]/g, ' ')      // hierarchy separators
    .replace(/[.,;:!?(){}\[\]"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned.split(' ').filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokens) {
    const key = lang === 'en' ? raw.toLowerCase() : raw;
    if (lang === 'en' && EN_STOPWORDS.has(key)) continue;
    // Drop pure-numeric tokens — codes are matched separately, not via FTS.
    if (/^\d+$/.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.join(' ');
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const pool = getPool();

  console.log('[ingest-hs-code-search] reading hs_codes ⨝ hs_code_display …');
  const r = await pool.query<SourceRow>(
    `SELECT h.code, d.path_en, d.path_ar
       FROM zatca_hs_codes h
       JOIN zatca_hs_code_display d USING (code)
      ORDER BY h.code`,
  );
  console.log(`[ingest-hs-code-search] ${r.rows.length} rows`);

  // Build the per-row inputs.
  type Prepared = SourceRow & {
    embeddingInput: string;
    tsvInputEn: string;
    tsvInputAr: string | null;
  };
  const prepared: Prepared[] = r.rows.map((row) => {
    const embeddingInput = row.path_ar
      ? `${row.path_en} | ${row.path_ar}`
      : row.path_en;
    return {
      ...row,
      embeddingInput,
      tsvInputEn: dedupeTokens(row.path_en, 'en') || row.code,
      tsvInputAr: row.path_ar ? dedupeTokens(row.path_ar, 'ar') : null,
    };
  });

  // Embed in batches.
  console.log(`[ingest-hs-code-search] embedding ${prepared.length} rows (batch=${BATCH_EMBED}) …`);
  const embeddings: number[][] = [];
  let embedT = 0;
  for (let i = 0; i < prepared.length; i += BATCH_EMBED) {
    const slice = prepared.slice(i, i + BATCH_EMBED);
    const t1 = Date.now();
    const vecs = await embedPassageBatch(slice.map((s) => s.embeddingInput));
    embedT += Date.now() - t1;
    embeddings.push(...vecs);
    if ((i / BATCH_EMBED) % 25 === 0) {
      const pct = ((i + slice.length) / prepared.length) * 100;
      console.log(`  ${i + slice.length}/${prepared.length}  (${pct.toFixed(1)}%)  embed_ms=${embedT}`);
    }
  }

  // TRUNCATE + bulk insert.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE zatca_hs_code_search');

    let inserted = 0;
    for (let i = 0; i < prepared.length; i += BATCH_INSERT) {
      const slice = prepared.slice(i, i + BATCH_INSERT);
      const sliceEmb = embeddings.slice(i, i + BATCH_INSERT);
      const placeholders: string[] = [];
      const values: unknown[] = [];
      let p = 1;
      for (let j = 0; j < slice.length; j++) {
        const row = slice[j]!;
        const v = sliceEmb[j]!;
        const ph = [
          `$${p++}`, // id (UUIDv7)
          `$${p++}`, // code
          `$${p++}`, // embedding_input
          `$${p++}`, // tsv_input_en
          `$${p++}`, // tsv_input_ar
          `$${p++}::vector`, // embedding
          `$${p++}`, // embedding_model
          `$${p++}`, // build_version
        ].join(',');
        placeholders.push(`(${ph})`);
        values.push(
          newId(),
          row.code,
          row.embeddingInput,
          row.tsvInputEn,
          row.tsvInputAr,
          `[${v.join(',')}]`,
          EMBEDDING_MODEL,
          BUILD_VERSION,
        );
      }
      await client.query(
        `INSERT INTO zatca_hs_code_search
           (id, code, embedding_input, tsv_input_en, tsv_input_ar,
            embedding, embedding_model, build_version)
         VALUES ${placeholders.join(',')}`,
        values,
      );
      inserted += slice.length;
      if (i % (BATCH_INSERT * 10) === 0) {
        console.log(`  insert ${inserted}/${prepared.length}`);
      }
    }

    await client.query('COMMIT');
    console.log(`[ingest-hs-code-search] ✓ inserted ${inserted} rows`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ingest-hs-code-search] failed, rolled back:', err);
    throw err;
  } finally {
    client.release();
  }

  console.log(`[ingest-hs-code-search] total wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
