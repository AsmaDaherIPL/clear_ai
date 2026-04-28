/**
 * AlternativesCard — ranked candidate picker.
 *
 * Inspired by the v5 design's `.cands` block:
 *   - Top-of-list row is the chosen code, highlighted with an orange wash,
 *     a "CHOSEN" flag, a gradient code, and a primary "Use this code" CTA.
 *   - Subsequent rows are siblings the picker considered. Each shows a
 *     numeric rank (02, 03, …), the 12-digit code, EN+AR descriptions,
 *     a confidence-style sim bar, and a secondary "Pick →" action.
 *   - Rows with retrieval_score < 0.20 are dimmed as low-relevance hits.
 *
 * IMPORTANT: `retrieval_score` is RRF (vector + BM25 + trigram), NOT a
 * calibrated confidence. We surface it as "retrieval" so users don't read
 * it as classification correctness.
 *
 * The rationale block + remediationHint stay above the row list so the
 * decision context is visible before the user starts comparing codes.
 */
import type { AlternativeLine } from '../lib/api';

type Props = {
  alternatives: AlternativeLine[];
  /** Code that was chosen as the result. When present, that row is the
   *  highlighted top entry; otherwise the top entry is just the highest
   *  retrieval score. */
  chosenCode?: string;
  /** Optional EN/AR/result description for the chosen line, so the top row
   *  can render full text even if the chosen code isn't in `alternatives`. */
  chosenDescriptionEn?: string | null;
  chosenDescriptionAr?: string | null;
  rationale?: string;
  /** Reason the user can act on (e.g. "add a distinguishing detail"). */
  remediationHint?: string;
  /** Optional pick handler. If absent, "Pick →" buttons are inert visually
   *  but still rendered so the layout stays balanced. */
  onPick?: (code: string) => void;
};

function formatCodeDotted(raw: string): string {
  // 1509200000.00 → 1509.20.00.00.00.00 (matches v5 design grouping)
  const d = (raw || '').replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
  return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10), d.slice(10, 12)]
    .filter(Boolean)
    .join('.');
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export default function AlternativesCard({
  alternatives,
  chosenCode,
  chosenDescriptionEn,
  chosenDescriptionAr,
  rationale,
  remediationHint,
  onPick,
}: Props) {
  // Build the rendered list: pull the chosen alt to the top (if it exists in
  // the alternatives array), otherwise synthesise a top row from the
  // chosenCode + chosen descriptions.
  const others = alternatives.filter((a) => a.code !== chosenCode);
  const fromList = alternatives.find((a) => a.code === chosenCode);

  const topRow: (AlternativeLine & { synthetic?: boolean }) | null =
    fromList
      ? fromList
      : chosenCode
        ? {
            code: chosenCode,
            description_en: chosenDescriptionEn ?? null,
            description_ar: chosenDescriptionAr ?? null,
            // Synthetic chosen rows don't carry a score — branch-sourced
            // siblings have no scores, and we don't want to manufacture a
            // misleading retrieval percentage on the chosen row anyway
            // (the "Picker's choice" chip already communicates pick status).
            retrieval_score: null,
            synthetic: true,
          }
        : null;

  // Nothing to show? Bail.
  if (!topRow && others.length === 0 && !rationale && !remediationHint) {
    return null;
  }

  // When ALL non-chosen alternatives have null scores, the surface was sourced
  // from branch enumeration (ADR-0012), not retrieval. We swap the heading
  // copy to match — "Branch alternatives" reads better than "Considered
  // alternatives" when there's no scoring/ranking semantic at play.
  const isBranchSourced =
    others.length > 0 && others.every((a) => a.retrieval_score === null);

  return (
    <div className="cands">
      <div className="cands-head">
        <div className="t">{isBranchSourced ? 'Branch alternatives' : 'Considered alternatives'}</div>
        <div className="s">
          {isBranchSourced
            ? "Other valid leaves under the chosen code's branch. Listed for comparison so you can refine the classification — every row is a real ZATCA leaf in the same legal family."
            : 'Top candidates the picker shortlisted. Similarity is text-match strength to your input — a sibling can outrank the chosen code here and still be the wrong classification.'}
        </div>
      </div>

      {remediationHint && (
        <div className="cands-hint">{remediationHint}</div>
      )}

      {rationale && (
        <p className="cands-rationale">{rationale}</p>
      )}

      {topRow && (
        <CandidateRow
          rank="✓"
          code={topRow.code}
          descEn={topRow.description_en}
          descAr={topRow.description_ar}
          score={topRow.retrieval_score}
          isTop
          {...(onPick ? { onPick } : {})}
        />
      )}

      {others.map((a, i) => (
        <CandidateRow
          key={a.code}
          rank={String(i + (topRow ? 2 : 1)).padStart(2, '0')}
          code={a.code}
          descEn={a.description_en}
          descAr={a.description_ar}
          score={a.retrieval_score}
          {...(onPick ? { onPick } : {})}
        />
      ))}
    </div>
  );
}

// ---------- row -------------------------------------------------------------

type RowProps = {
  rank: string;
  code: string;
  descEn: string | null;
  descAr: string | null;
  /**
   * Numeric score when alternatives come from RRF retrieval, `null` when
   * they come from deterministic branch enumeration (chosen code's HS-prefix
   * tree). Null score → render a "branch sibling" indicator, not a percent
   * bar — there's no similarity score to report.
   */
  score: number | null;
  isTop?: boolean;
  onPick?: (code: string) => void;
};

function CandidateRow({ rank, code, descEn, descAr, score, isTop, onPick }: RowProps) {
  const weak = score !== null && score < 0.2 && !isTop;
  const cls = ['cand', isTop && 'top', weak && 'weak'].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <div className="cand-l">
        <div className="cand-rank">{rank}</div>
        <div className="cand-body">
          {isTop && <div className="cand-flag">CHOSEN</div>}
          <div className="cand-code">{formatCodeDotted(code)}</div>
          <div className="cand-en">{descEn || '—'}</div>
          {descAr && (
            <div className="cand-ar" dir="rtl">{descAr}</div>
          )}
        </div>
      </div>

      <div className="cand-r">
        {isTop ? (
          // Deliberately no number on the chosen row. Showing a similarity %
          // here invites a wrong reading — siblings can have a HIGHER lexical
          // score yet be the wrong code (the picker overrides retrieval rank
          // when the runner-up is more specific or matches GIRs better).
          // A qualitative chip side-steps the false comparison.
          <div className="cand-picked" title="The picker (LLM + GIR rules) chose this code. Sibling similarity scores below are text-match strength, not correctness.">
            <span className="picked-dot" />
            <span>Picker’s choice</span>
          </div>
        ) : score === null ? (
          // Branch-sourced sibling — no similarity score applies. The
          // alternatives come from a deterministic enumeration of the chosen
          // code's HS-prefix branch (Phase 1 of the v3 alternatives redesign,
          // ADR-0012), not from retrieval. We render a small chip instead of
          // a percent bar so the contrast with the chosen row's "Picker's
          // choice" chip stays visually consistent.
          <div className="cand-sib" title="Sibling under the same legal branch as the chosen code. Listed for comparison only — no similarity score applies (alternatives are enumerated from the catalog tree, not from retrieval).">
            <span className="sib-dot" />
            <span>Branch sibling</span>
          </div>
        ) : (
          <div
            className="cand-sim"
            title="Lexical + vector similarity to your input. NOT a confidence in the code being correct — a sibling can outrank the chosen code here and still be wrong."
          >
            <span className="sim-k">similarity</span>
            <span className="sim-v">{pct(score)}</span>
            <div className="sim-bar">
              <div className="f" style={{ width: `${Math.min(100, score * 100)}%` }} />
            </div>
          </div>
        )}
        <button
          type="button"
          className={`btn-pick ${isTop ? 'primary' : ''}`}
          onClick={() => onPick?.(code)}
          {...(onPick ? {} : { disabled: true })}
        >
          {isTop ? 'Use this code' : 'Pick →'}
        </button>
      </div>
    </div>
  );
}
