/**
 * ClosestAlternativeCard — the "why not this one?" card.
 *
 * Surfaces the nearest FAISS competitor the justifier considered AND
 * explicitly rejected, with a single plain-English sentence stating the
 * discriminating fact. No GRI citations, no heading numbers — intended
 * for non-customs-expert review.
 *
 * Renders nothing when the justifier produced no viable competitor
 * (empty `why_not` filtered server-side).
 */
import type { ClosestAlternative } from '../lib/api';

type Props = { alt: ClosestAlternative | null | undefined };

function groupDigits(code: string): string {
  const c = code.replace(/\D/g, '');
  if (c.length !== 12) return code;
  return `${c.slice(0, 2)}.${c.slice(2, 4)}.${c.slice(4, 6)}.${c.slice(6, 8)}.${c.slice(8, 10)}.${c.slice(10, 12)}`;
}

export default function ClosestAlternativeCard({ alt }: Props) {
  if (!alt || !alt.why_not) return null;
  return (
    <div className="alt-card">
      <div className="alt-head">
        <span className="alt-kicker">Why not a similar code?</span>
        <span className="alt-chip">closest competitor</span>
      </div>
      <div className="alt-meta">
        <span className="alt-code-disp">{groupDigits(alt.hs_code)}</span>
        <span className="alt-desc-en">{alt.description_en || '—'}</span>
      </div>
      {alt.description_ar && (
        <div className="alt-desc-ar" dir="rtl">{alt.description_ar}</div>
      )}
      <p className="alt-why">{alt.why_not}</p>
    </div>
  );
}
