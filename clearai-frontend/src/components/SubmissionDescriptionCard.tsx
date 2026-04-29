/**
 * SubmissionDescriptionCard.tsx — lazy-loaded ZATCA submission text
 *
 * RESPONSIBILITIES:
 *   - On mount (or when request_id changes), fire a single GET
 *     /classify/newDescription?request_id=<uuid> request and render
 *     the EN + AR submission text returned by the backend.
 *   - Cancel any in-flight request via AbortController when the
 *     request_id changes mid-fetch, so a stale response from a
 *     previous classification can't land in a new card.
 *   - Render skeletons while loading; an inline retry control on
 *     error; the real text on success.
 *   - Self-unmount (render null) on `400 invalid_state` — that's
 *     the backend's signal that the original classification wasn't
 *     on the accepted 12-digit path, so there's no submission to
 *     generate. No need to push that decision back to the parent.
 *
 * STATE OWNED:
 *   - status:      'loading' | 'success' | 'error' | 'not_applicable'
 *   - data:        NewDescriptionResponse | null  (success payload)
 *   - retryNonce:  number — bump from the error-state retry button
 *                  to force the effect to refetch without changing
 *                  the parent-supplied requestId.
 * (The Copy AR button's "Copied" affordance is owned internally by
 *  CopyChip — see src/components/ui/copy-chip.tsx.)
 *
 * NOT YET IMPLEMENTED:
 *   - Cross-classification cache (would need to live in the parent or
 *     a context). In-component cache only — re-render with the same
 *     request_id refetches once on mount and reuses thereafter via the
 *     useEffect dep list.
 */

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyChip } from '@/components/ui/copy-chip';
import { api, ApiError, type NewDescriptionResponse } from '@/lib/api';

interface SubmissionDescriptionCardProps {
  /** UUID returned by /classify/describe at the top level. The card
   *  unmounts itself if this is null/undefined (no fetch to make). */
  requestId: string | null | undefined;
  className?: string;
}

type Status = 'loading' | 'success' | 'error' | 'not_applicable';

// Inline retry icon — used only by the error-state retry button.
// Copy / check icons used to live here too but moved into the shared
// CopyChip primitive (src/components/ui/copy-chip.tsx) when the
// submission card adopted that pill geometry.
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
  // Bumped to force a refetch from the retry button without changing
  // the parent-supplied requestId. The effect depends on (requestId,
  // retryNonce) so any change to either re-runs the request.
  const [retryNonce, setRetryNonce] = useState(0);
  // Holds the AbortController for the most recent in-flight request
  // so a rapid re-classification cancels the stale fetch cleanly.
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // No request_id yet → nothing to fetch; show skeletons (the parent
    // will normally only mount us once requestId is available, but
    // guard defensively).
    if (!requestId) return;

    // Cancel any previous in-flight request. This handles the
    // "user reclassified while the previous fetch was running" case
    // — without this, the stale response could land in the new card.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setStatus('loading');
    setData(null);

    api
      .newDescription(requestId, controller.signal)
      .then((res) => {
        // Guard against late resolution from an aborted request
        // (browsers typically reject on abort, but if a race wins
        // we still don't want to flash stale data).
        if (controller.signal.aborted) return;
        setData(res);
        setStatus('success');
      })
      .catch((err: unknown) => {
        // AbortError — caller cancelled; do nothing, the next effect
        // run owns the new state.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (controller.signal.aborted) return;

        // 400 invalid_state → the backend says there's no submission
        // to generate for this classification (e.g. it was needs_
        // clarification, not accepted). Self-unmount.
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

  // 400 invalid_state path — render absolutely nothing. The card
  // never appears in the result layout.
  if (status === 'not_applicable') return null;

  return (
    <div
      className={cn(
        'border border-[var(--line)] rounded-[var(--radius)] p-4 bg-[var(--surface)] flex flex-col gap-3',
        className,
      )}
    >
      {/* Header row — label on the start side, optional review pill on the end. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase">
          {t('res_suggest')}
        </div>
        {/* "Review required" pill — only when the LLM fell back to the
            deterministic guard. Replaces the old "Differs from ZATCA
            catalog" badge, which was meaningless because the guard
            always made differs_from_catalog true. */}
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

      {/* EN row — text or skeleton or em-dash on error. */}
      <div className="flex items-center gap-3 bg-[var(--line-2)] rounded-[var(--radius)] px-3.5 py-3 min-h-[44px]">
        <div className="flex-1 min-w-0 text-[14.5px] text-[var(--ink)] leading-[1.5]">
          {status === 'loading' && <Skeleton className="h-5 w-2/3" />}
          {status === 'success' && data?.description_en}
          {status === 'error' && (
            <span className="text-[var(--ink-3)] font-mono">—</span>
          )}
        </div>
      </div>

      {/* AR row — Copy AR chip on the visual LEFT, Arabic text on the
          visual RIGHT. The row stays LTR (default flex), so the first
          child lands on the visual left. The Arabic text node carries
          dir=rtl + physical `text-right` so the alignment locks to the
          right edge regardless of the document direction. */}
      <div className="flex items-center gap-3 bg-[var(--line-2)] rounded-[var(--radius)] px-3.5 py-3 min-h-[44px]">
        {/* Copy AR — same CopyChip primitive as the Copy code chip in
            ResultSingle, so both clipboard actions across the result
            card share the exact same pill geometry / typography.
            Disabled until the lazy fetch resolves. */}
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
            // Skeleton sits on the visual right edge of the text
            // column (where Arabic text would start), achieved via
            // `ml-auto` inside the LTR-flex parent.
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

      {/* AI disclaimer — italic, with a top border separator. Always
          visible; the legal warning matters in every state. */}
      <div className="text-[12.5px] text-[var(--ink-3)] italic leading-[1.5] pt-2 border-t border-[var(--line-2)]">
        {t('ai_disclaimer')}
      </div>
    </div>
  );
}
