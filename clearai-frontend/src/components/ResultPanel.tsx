/**
 * ResultPanel — top-level outcome card.
 *
 * Shows:
 *   - The HS code stamp + path + confidence
 *   - Customs description (EN + AR)
 *   - Duty rate
 *   - Review flags (flagged_for_review, agrees_with_naqel, naqel_bucket_hint)
 *   - Resolver rationale / error message
 *
 * Downstream sections (justification, evidence) are composed separately
 * by the parent so each can be shown/hidden independently.
 */
import type { ResolveResponse } from '../lib/api';
import HSCodePill from './HSCodePill';

type Props = { result: ResolveResponse };

function Flag({ on, label, tone }: { on: boolean; label: string; tone: 'good' | 'warn' | 'bad' }) {
  const toneClass =
    tone === 'good'
      ? 'border-najdi-500 text-najdi-700 bg-najdi-500/10'
      : tone === 'warn'
        ? 'border-stamp-500 text-stamp-600 bg-stamp-500/10'
        : 'border-crimson-500 text-crimson-600 bg-crimson-500/10';
  return (
    <span
      className={`inline-block text-[11px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-[2px] border ${toneClass} ${on ? '' : 'opacity-30'}`}
    >
      {label}
    </span>
  );
}

export default function ResultPanel({ result }: Props) {
  const {
    hs_code,
    path,
    confidence,
    customs_description_en,
    customs_description_ar,
    duty_rate_pct,
    flagged_for_review,
    agrees_with_naqel,
    naqel_bucket_hint,
    rationale,
    error,
    model_used,
  } = result;

  return (
    <section className="paper p-6 md:p-8 space-y-5">
      <HSCodePill code={hs_code} path={path} confidence={confidence} />

      {(customs_description_en || customs_description_ar) && (
        <div className="space-y-1.5">
          {customs_description_en && (
            <p className="font-display text-xl text-parchment-900 leading-snug">
              {customs_description_en}
            </p>
          )}
          {customs_description_ar && (
            <p className="arabic text-lg text-parchment-700 leading-snug">
              {customs_description_ar}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        {duty_rate_pct != null && (
          <span className="inline-flex items-baseline gap-1.5 font-mono text-sm">
            <span className="text-xs uppercase tracking-[0.2em] text-parchment-500">duty</span>
            <span className="text-parchment-900 font-600">{duty_rate_pct}%</span>
          </span>
        )}
        <span className="h-4 w-px bg-parchment-300" aria-hidden />
        <Flag on={flagged_for_review} label="review" tone="warn" />
        <Flag
          on={agrees_with_naqel === true}
          label={agrees_with_naqel === true ? 'agrees with Naqel' : agrees_with_naqel === false ? 'disagrees with Naqel' : 'no Naqel'}
          tone={agrees_with_naqel === true ? 'good' : agrees_with_naqel === false ? 'bad' : 'warn'}
        />
        {naqel_bucket_hint && (
          <span className="text-xs font-mono text-parchment-500">
            hint: {naqel_bucket_hint}
          </span>
        )}
        {model_used && (
          <span className="text-xs font-mono text-parchment-500 ml-auto">
            {model_used}
          </span>
        )}
      </div>

      {rationale && (
        <p className="text-sm text-parchment-700 font-display leading-relaxed border-l-2 border-parchment-300 pl-4 italic">
          {rationale}
        </p>
      )}

      {error && (
        <p className="text-sm text-crimson-600 font-mono border-l-2 border-crimson-500 pl-4">
          {error}
        </p>
      )}
    </section>
  );
}
