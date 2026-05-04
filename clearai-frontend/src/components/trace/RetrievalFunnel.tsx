/**
 * Retrieval-stage composite for the trace page.
 *
 * Rewritten in the May-3 trace iteration to reflect the actual
 * 2-stage hybrid pipeline (vector recall → BM25/trigram rerank,
 * fused via RRF). The pre-iteration version showed three "parallel
 * arms" run against the full catalog with equal weight — that is no
 * longer how retrieval works and the diagram lied about the system.
 *
 * The candidate-rows component is unchanged; only the diagram on top
 * was replaced.
 */
import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface AltRow {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  retrieval_score: number | null;
}

interface RetrievalFunnelProps {
  candidates: AltRow[];
  /** Total candidate count after fusion (event.candidate_count). */
  finalCount: number;
  /** Top-K returned by Stage 1 vector recall before sparse rerank. */
  stage1Count: number | null;
  /** event.top2_gap; used to flag the top-2 rows as "tied" when small. */
  top2Gap: number | null;
  /** Threshold below which the top-2 rows are flagged as "tied #1". */
  top2GapMin?: number;
  /** Initial number of candidate rows shown; rest behind a "Show more" toggle. */
  initialRows?: number;
}

export function RetrievalFunnel({
  candidates,
  finalCount,
  stage1Count,
  top2Gap,
  top2GapMin = 0.04,
  initialRows = 5,
}: RetrievalFunnelProps) {
  return (
    <div className="flex flex-col gap-3">
      <TwoStageDiagram stage1Count={stage1Count} finalCount={finalCount} />
      <CandidateRows
        candidates={candidates}
        top2Gap={top2Gap}
        top2GapMin={top2GapMin}
        initialRows={initialRows}
        finalCount={finalCount}
      />
    </div>
  );
}

/**
 * Two-stage retrieval diagram. Replaces the old MethodCards 3-up grid
 * (which suggested three parallel arms with equal weight against the
 * full catalog). The current pipeline is sequential: Stage 1 narrows
 * the catalog by vector similarity, Stage 2 reranks those narrowed
 * rows with BM25 + trigram, and RRF fuses the two ranking signals.
 */
function TwoStageDiagram({
  stage1Count,
  finalCount,
}: {
  stage1Count: number | null;
  finalCount: number;
}) {
  const t = useT();
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
      {/* Stage 1 — Vector recall card */}
      <article className="border border-[var(--line)] rounded-[var(--radius)] p-3.5 bg-[var(--surface)]">
        <header className="flex items-baseline justify-between gap-2 mb-1.5">
          <h3 className="font-mono text-[11px] tracking-[0.08em] uppercase text-[var(--ink-2)] font-medium m-0">
            {t('t2_retrieval_stage1_title')}
          </h3>
          {stage1Count != null && (
            <span className="font-mono text-[11.5px] text-[var(--ink-3)] tabular-nums">
              {stage1Count} rows
            </span>
          )}
        </header>
        <p className="text-[12.5px] text-[var(--ink-3)] leading-[1.5] m-0">
          {t('t2_retrieval_stage1_desc')}
        </p>
      </article>

      {/* Stage 2 — Sparse rerank card */}
      <article className="border border-[var(--line)] rounded-[var(--radius)] p-3.5 bg-[var(--surface)]">
        <header className="flex items-baseline justify-between gap-2 mb-1.5">
          <h3 className="font-mono text-[11px] tracking-[0.08em] uppercase text-[var(--ink-2)] font-medium m-0">
            {t('t2_retrieval_stage2_title')}
          </h3>
          <span className="font-mono text-[11.5px] text-[var(--ink-3)] tabular-nums">
            top {finalCount}
          </span>
        </header>
        <p className="text-[12.5px] text-[var(--ink-3)] leading-[1.5] m-0">
          {t('t2_retrieval_stage2_desc')}
        </p>
      </article>

      {/* RRF fusion params */}
      <article className="border border-[var(--line)] rounded-[var(--radius)] p-3.5 bg-[var(--line-2)] md:col-span-2">
        <header className="font-mono text-[11px] tracking-[0.08em] uppercase text-[var(--ink-2)] font-medium mb-1.5">
          {t('t2_retrieval_fusion_title')}
        </header>
        <ul className="text-[12.5px] text-[var(--ink-3)] leading-[1.55] m-0 ps-4 list-disc">
          <li>{t('t2_retrieval_fusion_desc_k60')}</li>
          <li>{t('t2_retrieval_fusion_desc_k200')}</li>
        </ul>
      </article>
    </div>
  );
}

interface CandidateRowsProps {
  candidates: AltRow[];
  top2Gap: number | null;
  top2GapMin: number;
  initialRows: number;
  finalCount: number;
}

/** Ranked candidate list with tied-top-2 highlighting and a "Show more" toggle. */
export function CandidateRows({
  candidates, top2Gap, top2GapMin, initialRows, finalCount,
}: CandidateRowsProps) {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const tied = top2Gap != null && top2Gap < top2GapMin;
  const visible = showAll ? candidates : candidates.slice(0, initialRows);
  const hidden = candidates.length - visible.length;

  if (candidates.length === 0) return null;

  return (
    <div>
      <div className="font-mono text-[10px] tracking-[0.1em] uppercase text-[var(--ink-3)] mb-2">
        {t('t2_retrieval_topk_label').replace('{n}', String(finalCount))}
        {' · '}
        <span className="text-[var(--ink-2)]">
          {visible.length} / {candidates.length}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {visible.map((c, i) => {
          const isTopTwo = (i === 0 || i === 1) && tied;
          return (
            <div
              key={`${c.code}-${i}`}
              className={cn(
                'grid items-center gap-3 px-3 py-2 rounded-[10px] border text-[13px]',
                isTopTwo
                  ? 'border-[color-mix(in_oklab,oklch(0.62_0.16_60)_35%,var(--line))] bg-[color-mix(in_oklab,oklch(0.95_0.06_75)_35%,var(--surface))]'
                  : 'border-[var(--line-2)] bg-[var(--surface)]',
              )}
              style={{ gridTemplateColumns: '22px 130px 1fr auto auto' }}
            >
              <span className="font-mono text-[11.5px] text-[var(--ink-3)] text-center">{i + 1}</span>
              <span className="font-mono text-[13px] text-[var(--ink)] font-medium truncate">{c.code}</span>
              <div className="min-w-0 flex flex-col">
                <span className="text-[var(--ink-2)] truncate">{c.description_en ?? '—'}</span>
                {c.description_ar && (
                  <span
                    dir="rtl"
                    lang="ar"
                    className="text-[12px] text-[var(--ink-3)] text-end truncate"
                    style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
                  >
                    {c.description_ar}
                  </span>
                )}
              </div>
              {isTopTwo ? (
                <span
                  className="font-mono text-[9.5px] tracking-[0.08em] uppercase px-1.5 py-0.5 rounded-full whitespace-nowrap"
                  style={{
                    background: 'color-mix(in oklab, oklch(0.62 0.16 60) 22%, var(--surface))',
                    color: 'oklch(0.42 0.13 60)',
                  }}
                >
                  {t('t2_candidate_tag_tied')}
                </span>
              ) : <span />}
              {c.retrieval_score != null
                ? <span className="font-mono text-[11.5px] text-[var(--ink-3)] tabular-nums">{c.retrieval_score.toFixed(2)}</span>
                : <span />}
            </div>
          );
        })}
      </div>

      {hidden > 0 && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1.5 px-2.5 py-1 font-mono text-[11px] tracking-[0.06em] uppercase text-[var(--ink-3)] bg-transparent border-0 cursor-pointer hover:text-[var(--ink-2)]"
        >
          ▸ {t('t2_retrieval_candidates_more').replace('{n}', String(hidden))}
        </button>
      )}
    </div>
  );
}
