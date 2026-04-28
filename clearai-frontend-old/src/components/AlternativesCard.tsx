/**
 * AlternativesCard — sibling comparison panel.
 *
 * After the v3 alternatives redesign (ADR-0012, ADR-0014, ADR-0015), the
 * alternatives surface is sourced one of three ways depending on what
 * happened upstream:
 *
 *   - Branch enumeration (HS-8 / HS-6 / HS-4): every row is a real catalog
 *     leaf in the same legal family as the chosen code. Source field tells
 *     us which scope. No retrieval score (deterministic SQL, not ranking).
 *   - Filtered RRF retrieval: when the picker didn't accept (best-effort,
 *     needs_clarification) or when even the widened branch was too sparse
 *     to satisfy ALTERNATIVES_MIN_SHOWN. Has a retrieval_score.
 *   - Branch-rank reorder: same source as branch enumeration but with
 *     fit + reason fields populated. Renders the per-row reasoning under
 *     each row so the user can see why a sibling fits / doesn't fit.
 *
 * The header copy adapts to the dominant source:
 *   - All branch_*  → "Branch alternatives"
 *   - All rrf       → "Considered alternatives" (legacy retrieval framing)
 *   - Mixed         → "Alternatives" + a hybrid subtitle
 *
 * The picker's rationale used to live in this card; it now lives in
 * HSResultCard, next to the chosen code itself, where it belongs.
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

type Source = NonNullable<AlternativeLine['source']>;

const SOURCE_LABEL: Record<Source, string> = {
  branch_8: 'Branch sibling',
  branch_6: 'Same heading',
  branch_4: 'Same chapter',
  rrf: 'Also retrieved',
};

const SOURCE_TOOLTIP: Record<Source, string> = {
  branch_8: 'Sibling under the same national subheading (HS-8) as the chosen code. Tightest commercial comparison.',
  branch_6: 'Sibling under the same HS-6 subheading. Shown when the HS-8 branch was sparse — broader legal comparison.',
  branch_4: 'Sibling under the same HS-4 heading. Rare; shown only when narrower scopes had too few leaves.',
  rrf: 'Closely-retrieved alternative. Surfaced when the catalog tree did not have enough siblings to compare against.',
};

const FIT_LABEL: Record<NonNullable<AlternativeLine['fit']>, string> = {
  fits: 'Fits',
  partial: 'Partial',
  excludes: 'Excludes',
};

export default function AlternativesCard({
  alternatives,
  chosenCode,
  chosenDescriptionEn,
  chosenDescriptionAr,
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
            // misleading retrieval percentage on the chosen row anyway.
            retrieval_score: null,
            synthetic: true,
          }
        : null;

  // Nothing to show? Bail.
  if (!topRow && others.length === 0 && !remediationHint) {
    return null;
  }

  // Header copy adapts to the source mix of NON-CHOSEN rows. We deliberately
  // ignore the chosen row when classifying — it's always rendered, regardless
  // of where it came from.
  //
  //   all branch_*           → "Branch alternatives"
  //   all rrf (legacy)       → "Considered alternatives"
  //   mixed (rare)           → neutral "Alternatives" with a hybrid subtitle
  let headerTitle = 'Alternatives';
  let headerSubtitle =
    'Other codes the system considered. Compare each against your product before submitting.';

  if (others.length > 0) {
    const sources = new Set(others.map((a) => a.source ?? 'rrf'));
    const allBranch = [...sources].every((s) => s.startsWith('branch_'));
    const allRrf = sources.size === 1 && sources.has('rrf');

    if (allBranch) {
      headerTitle = 'Branch alternatives';
      headerSubtitle =
        "Other valid leaves in the chosen code's legal family. Every row is a real ZATCA leaf — listed for comparison so you can refine the classification if a sibling fits your product better.";
    } else if (allRrf) {
      headerTitle = 'Considered alternatives';
      headerSubtitle =
        'Closest retrieval matches the system inspected. A sibling can outrank the chosen code on text similarity and still be the wrong classification — read the descriptions, not the percentages.';
    } else {
      // Mixed: branch siblings + RRF top-up
      headerTitle = 'Alternatives';
      headerSubtitle =
        "Branch siblings under the chosen code's family, plus closely-retrieved candidates where the branch was sparse. Per-row labels show which is which.";
    }
  }

  return (
    <div className="cands">
      <div className="cands-head">
        <div className="t">{headerTitle}</div>
        <div className="s">{headerSubtitle}</div>
      </div>

      {remediationHint && (
        <div className="cands-hint">{remediationHint}</div>
      )}

      {topRow && (
        <CandidateRow
          rank="✓"
          alt={topRow}
          isTop
          {...(onPick ? { onPick } : {})}
        />
      )}

      {others.map((a, i) => (
        <CandidateRow
          key={a.code}
          rank={String(i + (topRow ? 2 : 1)).padStart(2, '0')}
          alt={a}
          {...(onPick ? { onPick } : {})}
        />
      ))}
    </div>
  );
}

// ---------- row -------------------------------------------------------------

type RowProps = {
  rank: string;
  alt: AlternativeLine;
  isTop?: boolean;
  onPick?: (code: string) => void;
};

function CandidateRow({ rank, alt, isTop, onPick }: RowProps) {
  const { code, description_en: descEn, description_ar: descAr, retrieval_score: score, source, fit, reason } = alt;
  const weak = score !== null && score !== undefined && score < 0.2 && !isTop;
  const cls = ['cand', isTop && 'top', weak && 'weak', fit && `fit-${fit}`]
    .filter(Boolean)
    .join(' ');

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
          {/* Branch-rank's per-row reasoning, when present. Anchored under the
              description so the reason reads as an explanation of the row. */}
          {reason && !isTop && (
            <div className="cand-reason" title="Why this leaf does or doesn't fit, per the branch-rank reviewer.">
              {reason}
            </div>
          )}
        </div>
      </div>

      <div className="cand-r">
        {isTop ? (
          // Deliberately no number on the chosen row. Showing a similarity %
          // here invites a wrong reading — siblings can have a HIGHER lexical
          // score yet be the wrong code (the picker overrides retrieval rank
          // when the runner-up is more specific or matches GIRs better).
          <div className="cand-picked" title="The picker (LLM + GIR rules) chose this code. Siblings below are listed for comparison.">
            <span className="picked-dot" />
            <span>Picker’s choice</span>
          </div>
        ) : (
          <RowMeta source={source} score={score} fit={fit} />
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

/**
 * Right-side meta block on a sibling row. Renders, in priority order:
 *   1. Branch-rank fit chip (`fits` / `partial` / `excludes`) when present.
 *   2. Source badge (`Branch sibling` / `Same heading` / `Also retrieved`)
 *      always when source is known.
 *   3. Similarity bar when the row has an RRF score (legacy / non-accepted
 *      paths). The bar lives below the source badge so the spatial hierarchy
 *      stays consistent across paths.
 *
 * The whole point of this block is to be honest about *what* this row's
 * presence means — different sources mean different things, and the user
 * deserves to know.
 */
function RowMeta({
  source,
  score,
  fit,
}: {
  source: AlternativeLine['source'];
  score: number | null | undefined;
  fit: AlternativeLine['fit'];
}) {
  const src = source ?? (score !== null && score !== undefined ? 'rrf' : 'branch_8');
  const showScore = score !== null && score !== undefined;

  return (
    <div className="cand-meta">
      {fit && (
        <div className={`cand-fit cand-fit-${fit}`} title="Branch-rank reviewer's qualitative fit assessment.">
          <span>{FIT_LABEL[fit]}</span>
        </div>
      )}
      <div className={`cand-src cand-src-${src}`} title={SOURCE_TOOLTIP[src]}>
        <span className="src-dot" />
        <span>{SOURCE_LABEL[src]}</span>
      </div>
      {showScore && (
        <div className="cand-sim" title="Lexical + vector similarity to your input. NOT a confidence in the code being correct.">
          <span className="sim-k">similarity</span>
          <span className="sim-v">{pct(score!)}</span>
          <div className="sim-bar">
            <div className="f" style={{ width: `${Math.min(100, score! * 100)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
