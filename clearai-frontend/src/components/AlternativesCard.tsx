/**
 * AlternativesCard — the shortlist of other candidates the retrieval pulled.
 *
 * Replaces the legacy `ResultTabs` (justification / sources / closest
 * competitor) since the Fastify backend doesn't produce that data. We show
 * the top alternatives + their retrieval scores so the user can see what
 * the model considered before picking.
 *
 * IMPORTANT: retrieval_score here is RRF (reciprocal rank fusion of vector +
 * BM25 + trigram), not a confidence number. The label says "retrieval rank"
 * to avoid implying classification correctness.
 */
import type { AlternativeLine } from '../lib/api';

type Props = {
  alternatives: AlternativeLine[];
  /** Hide the alt that matches the chosen code so it doesn't appear twice. */
  chosenCode?: string;
  rationale?: string;
  /** Reason the user can act on (e.g. "add a distinguishing detail"). */
  remediationHint?: string;
};

function fmtScore(n: number): string {
  return n.toFixed(3);
}

export default function AlternativesCard({
  alternatives, chosenCode, rationale, remediationHint,
}: Props) {
  const list = alternatives.filter((a) => a.code !== chosenCode);
  if (list.length === 0 && !rationale && !remediationHint) return null;

  return (
    <div className="alts-card">
      <div className="alts-head">
        <div className="t">Considered alternatives</div>
        <div className="s">Top retrieval candidates the picker shortlisted</div>
      </div>

      {remediationHint && (
        <div className="alts-hint">{remediationHint}</div>
      )}

      {rationale && (
        <p className="alts-rationale">{rationale}</p>
      )}

      {list.length > 0 && (
        <ul className="alts-list">
          {list.map((a) => (
            <li key={a.code} className="alts-row">
              <div className="alts-row-main">
                <div className="alts-code">{a.code}</div>
                <div className="alts-desc">{a.description_en || '—'}</div>
                {a.description_ar && (
                  <div className="alts-desc-ar" dir="rtl">{a.description_ar}</div>
                )}
              </div>
              <div className="alts-score" title="Reciprocal-rank-fusion retrieval score (vector + BM25 + trigram). Not a confidence signal.">
                <span className="alts-score-k">retrieval</span>
                <span className="alts-score-v">{fmtScore(a.retrieval_score)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
