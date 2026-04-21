/**
 * HSResultCard — the top outcome card: confidence, segmented 12-digit
 * code, plain-language summary, primary/secondary actions.
 *
 * Segment split follows the v5 design: 4-2-2-2-2 grouped as
 *   CHAPTER · HEADING · SUB · NATIONAL · STAT · EXT
 * Only the first three segments use the orange gradient accent (the
 * international HS6 trunk — the rest is Saudi-national extension).
 */
import type { ResolveResponse } from '../lib/api';
import InlineBold from './InlineBold';

type Props = { result: ResolveResponse };

type Segment = { label: string; digits: string; accent: boolean };

function splitCode(code: string): Segment[] {
  // Right-pad with zeros if short so a partial result still renders cleanly.
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

function confLabel(c: number): string {
  if (c >= 0.85) return 'High confidence';
  if (c >= 0.6)  return 'Medium confidence';
  return 'Low confidence';
}

function copyToClipboard(s: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(s).catch(() => {});
  }
}

export default function HSResultCard({ result }: Props) {
  const {
    hs_code, confidence, plain_summary, customs_description_en, rationale,
  } = result;

  const segments = splitCode(hs_code);

  // Prefer the backend-provided plain_summary; fall back to building one
  // from customs_description_en + rationale so the panel never looks empty.
  const plain = plain_summary
    ?? (customs_description_en
          ? `This classifies as **${hs_code}** — ${customs_description_en}.`
          : rationale || '');

  return (
    <div className="hs-card">
      <div className="hs-top">
        <div className="k">SAUDI HS · 12-DIGIT</div>
        <div className="conf-pill">
          <span className="d" />
          <span>{confLabel(confidence)}</span>
          <span className="n">· {(confidence * 100).toFixed(0)}%</span>
        </div>
      </div>

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

      {plain && (
        <div className="plain"><InlineBold md={plain} /></div>
      )}

      <div className="hs-actions">
        <div className="al">
          <button className="btn-sec" type="button" onClick={() => copyToClipboard(hs_code)}>
            ⎘ Copy code
          </button>
          <button
            className="btn-sec"
            type="button"
            title="Flag this classification for human review"
            onClick={() => alert('Flag-for-review is not wired to the backend yet.')}
          >
            ⚐ Flag error
          </button>
        </div>
        <button
          className="btn-sec primary"
          type="button"
          title="Bayan XML export — coming soon"
          onClick={() => alert('ZATCA / Bayan XML export is not wired to the backend yet.')}
        >
          ↗ Generate ZATCA integration XML
        </button>
      </div>
    </div>
  );
}
