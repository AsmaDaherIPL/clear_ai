/** Retrieval-stage composite for the trace page: method cards, fusion flow, candidate rows. */
import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { StageGloss } from './StageBlock';

export interface AltRow {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  retrieval_score: number | null;
}

/** Static per-retrieval-method documentation. */
export interface MethodInfo {
  /** Display label, e.g. "Vectors" / "BM25 (keyword)" / "Trigram (fuzzy)". */
  name: string;
  /** Short paragraph explaining what this method does. */
  description: string;
}

interface RetrievalFunnelProps {
  methods: [MethodInfo, MethodInfo, MethodInfo];
  candidates: AltRow[];
  /** Total candidate count after fusion + dedup + filter (event.candidate_count). */
  finalCount: number;
  /** event.top2_gap; used to flag the top-2 rows as "tied" when small. */
  top2Gap: number | null;
  /** Threshold below which the top-2 rows are flagged as "tied #1" (visual cue only). */
  top2GapMin?: number;
  /** Initial number of candidate rows shown; rest behind a "Show more" toggle. */
  initialRows?: number;
}

export function RetrievalFunnel({
  methods,
  candidates,
  finalCount,
  top2Gap,
  top2GapMin = 0.05,
  initialRows = 5,
}: RetrievalFunnelProps) {
  return (
    <div className="flex flex-col gap-3">
      <MethodCards methods={methods} />
      <FlowStrip finalCount={finalCount} />
      <CandidateRows
        candidates={candidates}
        top2Gap={top2Gap}
        top2GapMin={top2GapMin}
        initialRows={initialRows}
      />
    </div>
  );
}

/** Three-up grid of method cards with name + description. */
export function MethodCards({ methods }: { methods: MethodInfo[] }) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-3">
      {methods.map((m, i) => (
        <article
          key={`${m.name}-${i}`}
          className="border border-[var(--line)] rounded-[var(--radius)] p-3 bg-[var(--surface)]"
        >
          <div className="font-mono text-[11px] tracking-[0.08em] uppercase text-[var(--ink-2)] font-medium mb-1.5">
            {m.name}
          </div>
          <p className="text-[12.5px] text-[var(--ink-3)] leading-[1.5] m-0">
            {m.description}
          </p>
        </article>
      ))}
    </div>
  );
}

/** One-line flow strip: three method names → fuse pill → final candidate count. */
export function FlowStrip({ finalCount }: { finalCount: number }) {
  const t = useT();
  return (
    <div className="bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius)] p-4">
      <div className="font-mono text-[10px] tracking-[0.1em] text-[var(--ink-3)] uppercase mb-3 flex items-center gap-1.5">
        {t('t2_retrieval_flow_title' as Parameters<typeof t>[0])}
        <StageGloss text={t('t2_glossary_rrf')} />
      </div>

      <div
        className="flex items-center gap-3 flex-wrap"
        aria-label="retrieval flow"
      >
        <span className="font-mono text-[12.5px] text-[var(--ink-2)] px-3 py-1.5 rounded-full border border-[var(--line)] bg-[var(--surface)]">
          {t('t2_retrieval_method_vectors')}
          {' + '}
          {t('t2_retrieval_method_bm25_short' as Parameters<typeof t>[0])}
          {' + '}
          {t('t2_retrieval_method_trigram_short' as Parameters<typeof t>[0])}
        </span>

        <span aria-hidden className="font-mono text-[var(--ink-3)] text-[18px] leading-none rtl:scale-x-[-1]">
          →
        </span>

        <span className="px-3 py-1.5 rounded-full border border-dashed border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent-soft)_60%,var(--surface))] font-mono text-[12.5px] text-[var(--accent)]">
          {t('t2_retrieval_funnel_fuse_title')}
        </span>

        <span aria-hidden className="font-mono text-[var(--ink-3)] text-[18px] leading-none rtl:scale-x-[-1]">
          →
        </span>

        <span className="font-mono text-[12.5px] font-semibold text-[var(--accent)] px-3 py-1.5 rounded-full border border-[var(--accent)] bg-[var(--surface)]">
          {finalCount}{' '}
          <span className="font-normal text-[var(--ink-3)]">
            {t('t2_retrieval_flow_candidates_label' as Parameters<typeof t>[0])}
          </span>
        </span>
      </div>
    </div>
  );
}

interface CandidateRowsProps {
  candidates: AltRow[];
  top2Gap: number | null;
  top2GapMin: number;
  initialRows: number;
}

/** Ranked candidate list with tied-top-2 highlighting and a "Show more" toggle. */
export function CandidateRows({
  candidates, top2Gap, top2GapMin, initialRows,
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
        {t('t2_retrieval_candidates_label')}
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
                    className="text-[12px] text-[var(--ink-3)] text-right truncate"
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
