/** Batch mode result card — placeholder table until wired to batch result data. */

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface ResultBatchProps {
  visible: boolean;
  className?: string;
}

export default function ResultBatch({ visible, className }: ResultBatchProps) {
  const t = useT();

  if (!visible) return null;

  return (
    <div
      className={cn(
        'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)] overflow-hidden',
        'animate-[fadeUp_0.35s_ease_both]',
        className,
      )}
    >
      <div className="px-[22px] py-[18px] flex items-start justify-between gap-4 border-b border-[var(--line-2)]">
        <div>
          <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase mb-1.5">
            {t('res_batch')}
          </div>
          <p className="text-[13px] text-[var(--ink-3)] italic m-0">
            ResultBatch stub — wire to batch result data in the next pass.
          </p>
        </div>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr>
            {(['th_line', 'th_desc', 'th_code', 'th_conf', 'th_status'] as const).map((key) => (
              <th
                key={key}
                className="text-start px-3.5 py-3 border-b border-[var(--line-2)] font-mono text-[11px] font-medium text-[var(--ink-3)] tracking-[0.06em] uppercase bg-[var(--line-2)]"
              >
                {t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={5} className="px-3.5 py-3 text-[13px] text-[var(--ink-3)] italic text-center">
              Batch rows will appear here after classification.
            </td>
          </tr>
        </tbody>
      </table>

      <div className="flex items-center justify-between gap-3 px-[22px] py-3.5 border-t border-[var(--line-2)] bg-[var(--line-2)]">
        <div className="text-[12.5px] text-[var(--ink-3)] inline-flex items-center gap-2.5">
          <span><b className="text-[var(--ink-2)] font-medium">{t('meta_latency')}</b> —</span>
          <span>·</span>
          <span><b className="text-[var(--ink-2)] font-medium">{t('meta_avg')}</b> —</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[13px] font-medium text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-colors duration-150"
          >
            {t('act_csv')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border-0 bg-[var(--accent)] text-white text-[13px] font-medium shadow-[0_4px_10px_-3px_rgba(233,123,58,0.4)] hover:bg-[var(--accent-ink)] transition-colors duration-150"
          >
            {t('act_xml_batch')}
          </button>
        </div>
      </div>
    </div>
  );
}
