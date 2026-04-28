/**
 * BestEffortCard — low-confidence fallback heading (ADR-0011).
 *
 * Visually distinct from HSResultCard so users never confuse a best-effort
 * heading with an accepted classification. Two layers of gating:
 *
 *   1. Tone: `warn` strip + amber pill, "VERIFY BEFORE USE" eyebrow.
 *   2. Verify-toggle: the code reveal is hidden behind a checkbox the user
 *      must consciously tick. Until ticked, only the chapter band is shown.
 *
 * The code is rendered as a partial prefix (2/4/6/8/10 digits) — never as
 * a 12-digit grid that would imply a final classification. The remaining
 * digits show as `··` placeholders so users see they're missing.
 */
import { useState } from 'react';
import type { ResultLine } from '../lib/api';

type Props = {
  result: ResultLine;
  rationale?: string;
  hint: string | null;
};

function copyToClipboard(s: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(s).catch(() => {});
  }
}

export default function BestEffortCard({ result, rationale, hint }: Props) {
  const [verified, setVerified] = useState(false);

  // The code is a 2/4/6/8/10-digit prefix. Pad with `··` placeholders to the
  // 12-digit slot grid so the visual asymmetry signals "this is partial".
  const digits = (result.code || '').replace(/\D/g, '').slice(0, 12);
  const slots: { digits: string; placeholder: boolean }[] = [];
  for (let i = 0; i < 12; i += 2) {
    const pair = digits.slice(i, i + 2);
    if (pair.length === 2) slots.push({ digits: pair, placeholder: false });
    else slots.push({ digits: '··', placeholder: true });
  }
  const labels = ['CHAPTER', 'HEADING', 'SUB', 'NATIONAL', 'STAT', 'EXT'];

  return (
    <div className="hs-card hs-card-warn be-card">
      <div className="hs-top">
        <div className="k">BEST-EFFORT HEADING · VERIFY BEFORE USE</div>
        <div className="conf-pill conf-warn">
          <span className="d" />
          <span>Low confidence</span>
        </div>
      </div>

      <div className="be-banner" role="note">
        This is <strong>not a final classification</strong>. The system could
        not match your input to a 12-digit code with confidence, so it has
        produced a chapter-level heading at most. A customs broker must
        verify and refine it before use.
      </div>

      <div className="hs-code be-code">
        {slots.map((s, i) => (
          <span key={i} style={{ display: 'contents' }}>
            <div className={`seg ${s.placeholder ? 'be-placeholder' : ''}`}>
              <div className={`d ${i < 3 && !s.placeholder ? 'accent' : ''}`}>
                {verified || !s.placeholder ? s.digits : s.placeholder ? '··' : s.digits}
              </div>
              <div className="l">{labels[i]}</div>
            </div>
            {i < slots.length - 1 && <span className="dot-sep">·</span>}
          </span>
        ))}
      </div>

      {rationale && (
        <div className="be-rationale">
          <span className="k">Why this heading</span>
          {rationale}
        </div>
      )}

      {hint && <p className="not-accepted-hint">{hint}</p>}

      <label className="be-verify">
        <input
          type="checkbox"
          checked={verified}
          onChange={(e) => setVerified(e.target.checked)}
        />
        <span>
          I understand this is a low-confidence heading, not a final
          classification. I will verify before use.
        </span>
      </label>

      <div className="hs-actions">
        <div className="al">
          <button
            className="btn-sec"
            type="button"
            disabled={!verified}
            onClick={() => copyToClipboard(result.code)}
            title={!verified ? 'Acknowledge before copying.' : 'Copy heading prefix'}
          >
            ⎘ Copy heading
          </button>
        </div>
      </div>
    </div>
  );
}
