/**
 * HSResultCard — top outcome card for an `accepted` decision.
 *
 * Renders the chosen 12-digit code (segmented as CHAPTER · HEADING · SUB ·
 * NATIONAL · STAT · EXT, accent on the international HS6 trunk), the
 * decision_reason as a plain-English label, EN+AR descriptions, and copy
 * actions. Confidence is presented as a label tied to decision_reason —
 * we don't fake a numeric confidence the backend doesn't compute.
 */
import type {
  DecisionStatus,
  DecisionReason,
  ResultLine,
} from '../lib/api';
import { reasonLabel, statusToTone } from '../lib/api';

type Props = {
  status: DecisionStatus;
  reason: DecisionReason;
  result: ResultLine;
  /** "Before" code shown only by /expand and /boost. */
  beforeCode?: string;
  /**
   * Picker rationale — short prose (typically 1–3 sentences) explaining
   * WHY this code was chosen, not WHAT it is. Rendered under the chosen
   * code grid so users see the reasoning attached to the decision rather
   * than mistakenly attached to "alternatives below".
   * Optional; absent on routes that don't compute one (e.g. some
   * /boost paths) and on the legacy non-rationale-bearing responses.
   */
  rationale?: string;
};

type Segment = { label: string; digits: string; accent: boolean };

function splitCode(code: string): Segment[] {
  const c = (code || '').replace(/\D/g, '').padEnd(12, '0').slice(0, 12);
  return [
    { label: 'CHAPTER',  digits: c.slice(0, 2),  accent: true  },
    { label: 'HEADING',  digits: c.slice(2, 4),  accent: true  },
    { label: 'SUB',      digits: c.slice(4, 6),  accent: true  },
    { label: 'NATIONAL', digits: c.slice(6, 8),  accent: false },
    { label: 'STAT',     digits: c.slice(8, 10), accent: false },
    { label: 'EXT',      digits: c.slice(10,12), accent: false },
  ];
}

function copyToClipboard(s: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(s).catch(() => {});
  }
}

/**
 * A heading-padded code (`xxxx00000000`) is a legitimate ZATCA-accepted
 * declaration but represents a coarser commit than a true 12-digit leaf.
 * The card shows a small "heading-level — add the material to refine"
 * eyebrow so users understand the level they're at without the
 * verify-toggle gating used for best-effort.
 *
 * Detection: digits 5-12 are all zeros AND digits 1-4 are non-zero.
 */
function isHeadingPaddedCode(code: string): boolean {
  return /^\d{4}0{8}$/.test(code) && code.slice(0, 4) !== '0000';
}

export default function HSResultCard({ status, reason, result, beforeCode, rationale }: Props) {
  const segments = splitCode(result.code);
  const tone = statusToTone(status);
  const isHeadingLevel = reason === 'heading_level_match' || isHeadingPaddedCode(result.code);

  return (
    <div className="hs-card">
      <div className="hs-top">
        <div className="k">
          SAUDI HS · 12-DIGIT
          {isHeadingLevel && <span className="hs-level-tag" title="Heading-level acceptance — ZATCA accepts this code as a valid declaration. Adding the missing classification attribute (typically material) would refine to a sub-heading.">· HEADING LEVEL</span>}
        </div>
        <div className={`conf-pill conf-${tone}`}>
          <span className="d" />
          <span>{reasonLabel(reason)}</span>
        </div>
      </div>

      {isHeadingLevel && (
        <div className="hs-heading-note" role="note">
          <strong>Heading-level acceptance.</strong> ZATCA accepts this 12-digit
          heading-padded code as a valid declaration. Adding the missing
          classification attribute (typically material — leather / textile /
          plastic) would refine to a sub-heading.
        </div>
      )}

      {beforeCode && beforeCode !== result.code && (
        <div className="before-after">
          <span className="ba-k">from</span>
          <span className="ba-code">{beforeCode}</span>
          <span className="ba-arrow" aria-hidden>→</span>
          <span className="ba-k">to</span>
          <span className="ba-code ba-after">{result.code}</span>
        </div>
      )}

      <div className="hs-code">
        {segments.map((s, i) => (
          <span key={i} style={{ display: 'contents' }}>
            <div className="seg">
              <div className={`d ${s.accent ? 'accent' : ''}`}>{s.digits}</div>
              <div className="l">{s.label}</div>
            </div>
            {i < segments.length - 1 && <span className="dot-sep">·</span>}
          </span>
        ))}
      </div>

      <div className="desc-grid">
        <div className="desc-cell">
          <div className="desc-head">
            <span className="k">ZATCA description · EN</span>
            <button
              type="button"
              className="desc-copy"
              title="Copy English description"
              aria-label="Copy English description"
              onClick={() => copyToClipboard(result.description_en || '')}
              disabled={!result.description_en}
            >
              ⎘ Copy
            </button>
          </div>
          {/* Long ZATCA descriptions can run 200+ words; clamp to 5 lines so the
              card stays scannable. The copy button above gives users access to
              the full text without forcing the layout to grow. */}
          <p className="desc-clamp">{result.description_en || '—'}</p>
        </div>
        <div className="desc-cell rtl" dir="rtl">
          <div className="desc-head">
            <span className="k">ZATCA description · AR</span>
            <button
              type="button"
              className="desc-copy"
              title="نسخ الوصف العربي"
              aria-label="Copy Arabic description"
              onClick={() => copyToClipboard(result.description_ar || '')}
              disabled={!result.description_ar}
            >
              ⎘ Copy
            </button>
          </div>
          <p className="desc-clamp">{result.description_ar || '—'}</p>
        </div>
      </div>

      {rationale && (
        <div className="hs-rationale">
          <span className="k">Why this code</span>
          <p>{rationale}</p>
        </div>
      )}

      <div className="hs-actions">
        <div className="al">
          <button className="btn-sec" type="button" onClick={() => copyToClipboard(result.code)}>
            ⎘ Copy code
          </button>
        </div>
        <button
          className="btn-sec primary"
          type="button"
          title="ZATCA / Bayan XML export — coming soon"
          onClick={() => alert('ZATCA integration XML export is not wired yet.')}
        >
          ↗ Generate ZATCA integration XML
        </button>
      </div>
    </div>
  );
}
