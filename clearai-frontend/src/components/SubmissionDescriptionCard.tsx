/** Lazy-loaded ZATCA submission text card; fetches on mount, self-unmounts on invalid_state. */

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, type NewDescriptionResponse } from '@/lib/api';

interface SubmissionDescriptionCardProps {
  /**
   * Inline submission description from a /pipeline/dispatch response. When
   * provided, no fetch happens — this is the new path.
   */
  inline?: { description_ar: string | null; description_en?: string | null } | null;
  /**
   * Legacy: UUID from POST /classifications; null/undefined skips the fetch.
   * Only used when `inline` is absent. Will be removed once /classifications
   * is fully retired.
   */
  requestId?: string | null | undefined;
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
  inline,
  requestId,
  className,
}: SubmissionDescriptionCardProps) {
  const t = useT();
  // Inline mode: the dispatch already returned the description — synthesize a
  // success state directly. No fetch, no retry button, no spinner. The inline
  // payload is the source of truth and never has the legacy `model_call` /
  // `source: 'guard_fallback'` metadata.
  const inlineData: NewDescriptionResponse | null = inline
    ? {
        description_ar: inline.description_ar ?? '',
        description_en: inline.description_en ?? '',
        source: 'llm',
      }
    : null;
  const initialStatus: Status =
    inline ? (inline.description_ar ? 'success' : 'not_applicable') : 'loading';

  const [status, setStatus] = useState<Status>(initialStatus);
  const [data, setData] = useState<NewDescriptionResponse | null>(inlineData);
  /** Bumped by the retry button to re-run the effect without changing requestId. */
  const [retryNonce, setRetryNonce] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Inline mode short-circuits the fetch entirely.
    if (inline) {
      setStatus(inline.description_ar ? 'success' : 'not_applicable');
      setData(
        inline.description_ar
          ? {
              description_ar: inline.description_ar,
              description_en: inline.description_en ?? '',
              source: 'llm',
            }
          : null,
      );
      return;
    }

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
  }, [inline, requestId, retryNonce]);

  if (status === 'not_applicable') return null;

  return (
    // Mockup-match: this block is NOT a separate card with its own
    // border. It sits inline inside the main result card as a labeled
    // section — label up top, two stacked text rows on a slightly
    // darker cream surface (--line-2), italic disclaimer at the
    // bottom. Each row carries an icon-only copy button on the inline
    // end so brokers can copy EN or AR independently.
    <div
      className={cn('flex flex-col gap-2', className)}
    >
      {/* Header row — label + optional review-required pill. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.08em] uppercase">
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

      {/* EN row */}
      <div className="flex items-center gap-2 px-4 py-3 rounded-md text-[14px] text-[var(--ink)] leading-[1.5]"
           style={{ background: 'oklch(0.97 0.005 80)' }}>
        <div className="flex-1 min-w-0">
          {status === 'loading' && <Skeleton className="h-5 w-2/3" />}
          {status === 'success' && data?.description_en}
          {status === 'error' && (
            <span className="text-[var(--ink-3)] font-mono">—</span>
          )}
        </div>
        {status === 'success' && data?.description_en && (
          <CopyIcon text={data.description_en} title="Copy English" />
        )}
      </div>

      {/* AR row — RTL with copy icon on inline-end */}
      <div className="flex items-center gap-2 px-4 py-3 rounded-md text-[14px] text-[var(--ink)] leading-[1.5]"
           style={{ background: 'oklch(0.97 0.005 80)' }}>
        <div
          dir="rtl"
          lang="ar"
          className="flex-1 min-w-0 text-end"
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
        {status === 'success' && data?.description_ar && (
          <CopyIcon text={data.description_ar} title="Copy Arabic" />
        )}
      </div>

      {/* Model footer — only on LLM success with model_call metadata. */}
      {status === 'success' && data?.source === 'llm' && data.model_call && (
        <div className="text-[11.5px] text-[var(--ink-3)] font-mono mt-1 flex items-center gap-2">
          <span aria-hidden>🤖</span>
          <span>{familyOf(data.model_call.model)}</span>
          <span>·</span>
          <span>{fmtMs(data.model_call.latency_ms)}</span>
        </div>
      )}

      {/* AI disclaimer — always visible, italic ink-3, no top border per mockup. */}
      <div className="text-[12px] text-[var(--ink-3)] italic leading-[1.5] mt-1.5">
        {t('ai_disclaimer')}
      </div>
    </div>
  );
}

/** Minimal icon-only copy button used inside the suggested-submission rows. */
function CopyIcon({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex items-center justify-center p-1.5 rounded-md text-[var(--ink-3)] hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] hover:text-[var(--ink)] transition-colors duration-150 cursor-pointer border-0 bg-transparent flex-shrink-0"
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
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
