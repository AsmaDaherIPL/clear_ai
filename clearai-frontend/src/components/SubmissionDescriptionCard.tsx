/**
 * SubmissionDescriptionCard — Phase 5.
 *
 * Renders the ZATCA-safe Arabic submission description (with English
 * companion line) generated for the chosen 12-digit code. The Arabic line
 * is what the broker will paste directly into the ZATCA declaration field;
 * it differs from the catalog AR by at least one token to satisfy ZATCA's
 * "no word-for-word duplication" rule.
 *
 * Visual treatment:
 *   - LLM-clean path → standard card, green "Differs from ZATCA catalog ✓"
 *     check, copy buttons enabled.
 *   - guard_fallback / llm_failed → amber warning strip, "AI-generated
 *     fallback — please review before submission" banner. Copy still
 *     enabled (broker may want to start from it and edit) but the warning
 *     dominates.
 *
 * NOTE: this is an AI suggestion, not an authoritative legal declaration.
 * The card always carries a "review before submission" notice so the
 * broker stays in the loop.
 */
import type { SubmissionDescription } from '../lib/api';

type Props = {
  submission: SubmissionDescription;
};

function copyToClipboard(s: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(s).catch(() => {});
  }
}

export default function SubmissionDescriptionCard({ submission }: Props) {
  const isFallback = submission.source !== 'llm';

  return (
    <div className={`sub-card${isFallback ? ' sub-card-warn' : ''}`}>
      <div className="sub-top">
        <div className="k">SUGGESTED ZATCA SUBMISSION DESCRIPTION</div>
        {submission.differs_from_catalog ? (
          <div className="sub-pill sub-pill-ok" title="The Arabic submission text differs from the ZATCA catalog description by at least one token, so it satisfies ZATCA's word-for-word duplication rule.">
            <span className="sub-dot" />
            <span>Differs from ZATCA catalog</span>
          </div>
        ) : (
          <div className="sub-pill sub-pill-warn" title="WARNING: the suggested Arabic text matches the catalog word-for-word. ZATCA will reject this. Edit before submission.">
            <span className="sub-dot" />
            <span>Catalog match — review</span>
          </div>
        )}
      </div>

      {isFallback && (
        <div className="sub-banner" role="note">
          {submission.source === 'guard_fallback'
            ? 'The AI generator could not produce a sufficiently distinct phrasing. Below is a deterministic fallback — please review and edit before submitting to ZATCA.'
            : 'The AI generator was unable to produce a clean submission description. Below is a recovery output — please review and edit before submitting to ZATCA.'}
        </div>
      )}

      <div className="sub-body">
        <div className="sub-row sub-row-ar" dir="rtl">
          <div className="sub-text">{submission.description_ar || '—'}</div>
          <button
            className="btn-sec sub-copy"
            type="button"
            onClick={() => copyToClipboard(submission.description_ar)}
            title="Copy Arabic submission text"
          >
            ⎘ Copy AR
          </button>
        </div>
        <div className="sub-row sub-row-en">
          <div className="sub-text">{submission.description_en || '—'}</div>
          <button
            className="btn-sec sub-copy"
            type="button"
            onClick={() => copyToClipboard(submission.description_en)}
            title="Copy English submission text"
          >
            ⎘ Copy EN
          </button>
        </div>
      </div>

      {submission.rationale && (
        <div className="sub-rationale">
          <span className="k">Why this phrasing</span>
          {submission.rationale}
        </div>
      )}

      <div className="sub-disclaimer">
        AI-generated suggestion. The submitted description is a legal
        declaration — verify it accurately describes your product before
        pasting into ZATCA.
      </div>
    </div>
  );
}
