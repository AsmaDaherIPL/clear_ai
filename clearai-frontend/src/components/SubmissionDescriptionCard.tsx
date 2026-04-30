/** Lazy-loaded ZATCA submission text card; fetches on mount, self-unmounts on invalid_state. */

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyChip } from '@/components/ui/copy-chip';
import { api, ApiError, type NewDescriptionResponse } from '@/lib/api';

interface SubmissionDescriptionCardProps {
  /** UUID from POST /classifications; null/undefined skips the fetch. */
  requestId: string | null | undefined;
  className?: string;
}

type Status = 'loading' | 'success' | 'error' | 'not_applicable';

const RetryIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

export default function SubmissionDescriptionCard({
  requestId,
  className,
}: SubmissionDescriptionCardProps) {
  const t = useT();
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<NewDescriptionResponse | null>(null);
  /** Bumped by the retry button to re-run the effect without changing requestId. */
  const [retryNonce, setRetryNonce] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!requestId) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setStatus('loading');
    setData(null);

    api
      .submissionDescription(requestId, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setData(res);
        setStatus('success');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (controller.signal.aborted) return;

        // 400 invalid_state → no submission to generate; self-unmount.
        if (
          err instanceof ApiError &&
          err.status === 400 &&
          (err.body as { error?: string } | null)?.error === 'invalid_state'
        ) {
          setStatus('not_applicable');
          return;
        }

        setStatus('error');
      });

    return () => {
      controller.abort();
    };
  }, [requestId, retryNonce]);

  if (status === 'not_applicable') return null;

  return (
    <div
      className={cn(
        'border border-[var(--line)] rounded-[var(--radius)] p-4 bg-[var(--surface)] flex flex-col gap-3',
        className,
      )}
    >
      {/* Header row — label + optional review-required pill. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase">
          {t('res_suggest')}
        </div>
        {/* Review-required pill: shown when the LLM fell back to the deterministic guard. */}
        {status === 'success' && data?.source === 'guard_fallback' && (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium"
            style={{ background: 'oklch(0.95 0.06 75)', color: 'oklch(0.42 0.13 60)' }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: 'oklch(0.62 0.16 60)' }}
            />
            {t('review_required')}
          </span>
        )}
      </div>

      {/* EN row. */}
      <div className="flex items-center gap-3 bg-[var(--line-2)] rounded-[var(--radius)] px-3.5 py-3 min-h-[44px]">
        <div className="flex-1 min-w-0 text-[14.5px] text-[var(--ink)] leading-[1.5]">
          {status === 'loading' && <Skeleton className="h-5 w-2/3" />}
          {status === 'success' && data?.description_en}
          {status === 'error' && (
            <span className="text-[var(--ink-3)] font-mono">—</span>
          )}
        </div>
      </div>

      {/* AR row — LTR flex keeps Copy chip on the visual left; Arabic text dir=rtl. */}
      <div className="flex items-center gap-3 bg-[var(--line-2)] rounded-[var(--radius)] px-3.5 py-3 min-h-[44px]">
        <CopyChip
          text={data?.description_ar ?? ''}
          label="Copy AR"
          disabled={status !== 'success'}
          className="flex-shrink-0"
        />

        <div
          dir="rtl"
          lang="ar"
          className="flex-1 min-w-0 text-[14.5px] text-[var(--ink)] leading-[1.5] text-right"
          style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif" }}
        >
          {status === 'loading' && (
            <Skeleton className="h-6 w-1/2 ml-auto" />
          )}
          {status === 'success' && data?.description_ar}
          {status === 'error' && (
            <button
              type="button"
              onClick={() => setRetryNonce((n) => n + 1)}
              dir="ltr"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] text-[12.5px] font-medium text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-colors duration-150"
            >
              <RetryIcon />
              <span>{t('submission_failed')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Model footer — only on LLM success with model_call metadata. */}
      {status === 'success' && data?.source === 'llm' && data.model_call && (
        <div className="text-[11.5px] text-[var(--ink-3)] font-mono pt-2 border-t border-[var(--line-2)] flex items-center gap-2">
          <span aria-hidden>🤖</span>
          <span>{familyOf(data.model_call.model)}</span>
          <span>·</span>
          <span>{fmtMs(data.model_call.latency_ms)}</span>
        </div>
      )}

      {/* AI disclaimer — always visible. */}
      <div className="text-[12.5px] text-[var(--ink-3)] italic leading-[1.5] pt-2 border-t border-[var(--line-2)]">
        {t('ai_disclaimer')}
      </div>
    </div>
  );
}

/** Extract the model family ("Sonnet" / "Haiku" / "Opus") from a deployment id. */
function familyOf(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return model;
}

/** Format milliseconds as either "Xms" (< 1s) or "X.XXs" (≥ 1s). */
function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}
