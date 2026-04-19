/**
 * EvidenceDetails — collapsible FAISS evidence table.
 *
 * Ranks 1..10 of the nearest neighbours from the semantic index, so a
 * reviewer can see *why* the resolver leaned where it did. Score is
 * clamped 0..1 and shown as a bar. Arabic descriptions render RTL.
 */
import type { EvidenceItem } from '../lib/api';

type Props = { items: EvidenceItem[]; chosenCode: string };

export default function EvidenceDetails({ items, chosenCode }: Props) {
  if (items.length === 0) return null;

  return (
    <details className="paper p-5 md:p-6 group" open={false}>
      <summary className="cursor-pointer list-none flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.25em] text-parchment-500 font-mono">
          FAISS evidence · {items.length} candidates
        </span>
        <span className="text-parchment-400 group-open:rotate-180 transition-transform">▾</span>
      </summary>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-parchment-500 font-mono border-b border-parchment-200">
              <th className="py-2 pr-3 w-8">#</th>
              <th className="py-2 pr-3 w-24">score</th>
              <th className="py-2 pr-3">HS code</th>
              <th className="py-2 pr-3">description</th>
              <th className="py-2 pr-3 w-16 text-right">duty</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const chosen = item.hs_code === chosenCode;
              const scorePct = Math.max(0, Math.min(1, item.score)) * 100;
              return (
                <tr
                  key={`${item.rank}-${item.hs_code}`}
                  className={
                    chosen
                      ? 'border-b border-parchment-200 bg-stamp-500/5'
                      : 'border-b border-parchment-200'
                  }
                >
                  <td className="py-2 pr-3 font-mono text-parchment-500">{item.rank}</td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-14 bg-parchment-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-najdi-500"
                          style={{ width: `${scorePct}%` }}
                        />
                      </div>
                      <span className="font-mono text-xs text-parchment-700">
                        {item.score.toFixed(3)}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 pr-3 font-mono text-parchment-900">
                    {item.hs_code}
                    {chosen && (
                      <span className="ml-2 text-[10px] uppercase tracking-widest text-stamp-600">
                        chosen
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    <div className="font-display">{item.description_en || '—'}</div>
                    {item.description_ar && (
                      <div className="arabic text-parchment-700 text-sm mt-0.5">
                        {item.description_ar}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 font-mono text-right text-parchment-700">
                    {item.duty_rate_pct == null ? '—' : `${item.duty_rate_pct}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
