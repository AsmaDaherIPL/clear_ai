/**
 * HSLadderCard — the plain-English classification ladder.
 *
 * Renders the four-rung hierarchy (big category → family → sub-family →
 * exact item) using ClearAI's orange accent only on the rung that represents
 * the final resolved code. Bilingual: EN left, AR right (RTL).
 *
 * This card is the primary non-expert explanation — it replaces the need
 * to read a GRI-heavy justification to understand why a code was chosen.
 */
import type { HSLadderRow } from '../lib/api';

type Props = { rows: HSLadderRow[]; resolvedCode: string };

function groupDigits(code: string): string {
  // 12-digit → 12.34.56.78.90.12; shorter codes render as-is.
  const c = code.replace(/\D/g, '');
  if (c.length !== 12) return code;
  return `${c.slice(0, 2)}.${c.slice(2, 4)}.${c.slice(4, 6)}.${c.slice(6, 8)}.${c.slice(8, 10)}.${c.slice(10, 12)}`;
}

export default function HSLadderCard({ rows, resolvedCode }: Props) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="ladder">
      <div className="ladder-head">
        <div className="t">How we got to this code</div>
        <div className="s">plain-English chain</div>
      </div>
      <ol className="ladder-rows">
        {rows.map((r, i) => {
          const isFinal = r.code === resolvedCode || i === rows.length - 1;
          return (
            <li key={`${r.code}-${i}`} className={`ladder-row ${isFinal ? 'final' : ''}`}>
              <div className="ladder-rail">
                <span className="dot" />
                {i < rows.length - 1 && <span className="line" />}
              </div>
              <div className="ladder-body">
                <div className="lvl">
                  <span className="lbl">{r.level}</span>
                  <span className="code">{groupDigits(r.code)}</span>
                </div>
                <div className="desc-en">{r.description_en || '—'}</div>
                {r.description_ar && (
                  <div className="desc-ar" dir="rtl">{r.description_ar}</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
