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

export default function HSResultCard({ status, reason, result, beforeCode }: Props) {
  const segments = splitCode(result.code);
  const tone = statusToTone(status);

  return (
    <div className="hs-card">
      <div className="hs-top">
        <div className="k">SAUDI HS · 12-DIGIT</div>
        <div className={`conf-pill conf-${tone}`}>
          <span className="d" />
          <span>{reasonLabel(reason)}</span>
        </div>
      </div>

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
          <span className="k">ZATCA description · EN</span>
          {result.description_en || '—'}
        </div>
        <div className="desc-cell rtl" dir="rtl">
          <span className="k">ZATCA description · AR</span>
          {result.description_ar || '—'}
        </div>
      </div>

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
