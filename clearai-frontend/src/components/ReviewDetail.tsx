/**
 * ReviewDetail — full decision surface for a single review queue row.
 *
 * URL: /review/:id?batch_id=<uuid>
 *
 * Actions: approve | override | reject | block_from_submission
 * Candidate list populates the override code input on radio selection.
 * Block requires a confirmation modal.
 * On success: toast + navigate to /review?batch_id=... after 1s.
 */

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';
import type { ReviewQueueRow, ReviewCandidate, CandidateFit, ReviewDecision } from '@/lib/api';
import TopBar from './TopBar';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1_000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

const CODE_RE = /^\d{12}$/;

/**
 * Whitelist mapping for source_arm values.
 * Only the canonical action names are shown to operators.
 * Forbidden track_a/track_b labels are suppressed and shown as "retrieval"
 * (the neutral term) so legacy backend payloads don't leak internal naming.
 */
const SOURCE_ARM_LABELS: Record<string, string> = {
  description_classifier: 'Description classifier',
  code_resolver:          'Code resolver',
  merchant_resolution:    'Merchant code',
  lexical:                'Lexical search',
  vector:                 'Semantic search',
  // legacy arms — map to neutral labels, never show raw value
  track_a:                'Description classifier',
  track_b:                'Code resolver',
};

function formatSourceArm(arm: string | null | undefined): string {
  if (!arm) return '—';
  return SOURCE_ARM_LABELS[arm] ?? 'Retrieval';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10.5px] tracking-[0.12em] uppercase text-[var(--ink-3)] mb-1.5">
      {children}
    </div>
  );
}

function MetaPill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block px-2 py-[3px] rounded-full font-mono text-[10.5px] tracking-[0.08em] uppercase',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Renders the fit verdict for a candidate.
 * When isCurrent=true (picker's chosen leaf), does_not_fit is suppressed
 * and shown as "fits (permissive)" per the permissive-fits rule:
 * silence on unconstrained dimensions is not contradiction — a leaf the
 * picker accepted is by definition fits at the classification level.
 */
function FitBadge({ fit, isCurrent = false, t }: { fit: CandidateFit; isCurrent?: boolean; t: ReturnType<typeof useT> }) {
  // Permissive-fits rule: picker's chosen candidate must never show does_not_fit.
  const effectiveFit = isCurrent && fit === 'does_not_fit' ? 'fits' : fit;
  const cls =
    effectiveFit === 'fits'
      ? 'text-[oklch(0.40_0.13_140)]'
      : effectiveFit === 'partial'
        ? 'text-[oklch(0.48_0.14_60)]'
        : 'text-[var(--ink-3)]';
  const label =
    effectiveFit === 'fits'
      ? isCurrent && fit === 'does_not_fit'
        ? `${t('review_fit_fits')} (permissive)`
        : t('review_fit_fits')
      : effectiveFit === 'partial'
        ? t('review_fit_partial')
        : t('review_fit_does_not_fit');
  return (
    <span className={cn('font-mono text-[11px] tracking-[0.06em] uppercase', cls)}>
      {label}
    </span>
  );
}

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDone, 3_000);
    return () => clearTimeout(id);
  }, [onDone]);

  return (
    <div
      className={cn(
        'fixed bottom-6 start-1/2 -translate-x-1/2 z-50',
        'px-5 py-3 rounded-[10px]',
        'bg-[oklch(0.18_0.01_250)] text-white text-[13px] font-medium',
        'shadow-[0_8px_32px_rgba(0,0,0,0.35)]',
        'animate-[fadeUp_0.25s_ease_both]',
      )}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation modal for block action
// ---------------------------------------------------------------------------

interface BlockModalProps {
  description: string;
  currentCode: string | null | undefined;
  notes: string;
  t: ReturnType<typeof useT>;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}

function BlockModal({ description, currentCode, notes, t, onConfirm, onCancel, submitting }: BlockModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,8,4,0.55)] backdrop-blur-[3px]"
      aria-modal="true"
      role="dialog"
    >
      <div
        className="w-full max-w-[440px] mx-4 bg-[var(--surface)] border border-[var(--line)] rounded-[10px] shadow-[0_24px_64px_-8px_rgba(0,0,0,0.35)] p-6"
      >
        <h2 className="m-0 text-[17px] font-semibold text-[var(--ink)] tracking-[-0.01em]">
          {t('review_block_confirm_title')}
        </h2>

        <p className="mt-3 mb-0 text-[13px] text-[var(--ink-2)] leading-relaxed">
          {t('review_block_confirm_body')}
        </p>

        <div className="mt-4 p-3.5 rounded-[8px] bg-[var(--bg)] border border-[var(--line-2)] space-y-2">
          <div>
            <SectionLabel>Item</SectionLabel>
            <p className="m-0 text-[13px] text-[var(--ink)] leading-snug">{description}</p>
          </div>
          {currentCode && (
            <div>
              <SectionLabel>{t('review_detail_current_code')}</SectionLabel>
              <span className="font-mono text-[14px] text-[var(--ink)]">{currentCode}</span>
            </div>
          )}
          {notes.trim() && (
            <div>
              <SectionLabel>{t('review_detail_notes_label')}</SectionLabel>
              <p className="m-0 text-[13px] text-[var(--ink-2)] leading-snug">{notes}</p>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className={cn(
              'px-4 py-2 rounded-[8px] text-[13px]',
              'border border-[var(--line)] bg-[var(--surface)]',
              'text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]',
              'transition-colors duration-150 disabled:opacity-50',
            )}
          >
            {t('review_block_confirm_cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className={cn(
              'px-4 py-2 rounded-[8px] text-[13px] font-medium text-white',
              'bg-[oklch(0.55_0.18_25)] hover:brightness-110',
              'transition-[filter] duration-150 disabled:opacity-60 disabled:cursor-progress',
            )}
          >
            {submitting ? '…' : t('review_block_confirm_cta')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CandidateRow
// ---------------------------------------------------------------------------

interface CandidateRowProps {
  candidate: ReviewCandidate;
  index: number;
  isSelected: boolean;
  radioEnabled: boolean;
  onSelect: (code: string) => void;
  t: ReturnType<typeof useT>;
}

function CandidateRow({ candidate, index, isSelected, radioEnabled, onSelect, t }: CandidateRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isCurrent = candidate.is_current;

  return (
    <div
      className={cn(
        'rounded-[8px] border transition-colors duration-100',
        isCurrent
          ? 'border-[var(--accent)] bg-[oklch(0.97_0.015_55)]'
          : 'border-[var(--line)] bg-[var(--surface)]',
        isSelected && !isCurrent && 'border-[var(--ink-3)]',
      )}
    >
      <div className="flex items-start gap-3 p-3.5">
        {/* Radio */}
        <div className="flex-shrink-0 mt-[3px]">
          <input
            type="radio"
            id={`cand-${index}`}
            name="override_candidate"
            value={candidate.code}
            disabled={!radioEnabled}
            checked={isSelected}
            onChange={() => onSelect(candidate.code)}
            className="accent-[var(--accent)] w-4 h-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <label
              htmlFor={`cand-${index}`}
              className={cn(
                'font-mono text-[14.5px] tracking-[0.01em] font-medium',
                radioEnabled ? 'cursor-pointer' : 'cursor-not-allowed',
                'text-[var(--ink)]',
              )}
            >
              {candidate.code}
            </label>

            <FitBadge fit={candidate.fit} isCurrent={isCurrent} t={t} />

            {isCurrent && (
              <MetaPill className="bg-[var(--accent)] text-white">
                Current
              </MetaPill>
            )}

            <span className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.06em] uppercase">
              {t('review_detail_source')} {formatSourceArm(candidate.source_arm)}
            </span>

            <span className="ms-auto font-mono text-[11px] text-[var(--ink-3)]">
              {candidate.rerank_score.toFixed(3)}
            </span>
          </div>

          {candidate.description_en && (
            <p className="mt-1 m-0 text-[12.5px] text-[var(--ink-2)] leading-snug">
              {candidate.description_en}
            </p>
          )}

          {candidate.description_ar && (
            <p className="mt-0.5 m-0 text-[12px] text-[var(--ink-3)] leading-snug" dir="rtl">
              {candidate.description_ar}
            </p>
          )}

          {candidate.rationale && (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-[var(--ink-3)] hover:text-[var(--ink-2)] transition-colors"
              >
                {expanded ? 'Hide' : t('review_detail_rationale')}
              </button>
              {expanded && (
                <p className="mt-1 m-0 text-[12.5px] text-[var(--ink-2)] leading-relaxed italic">
                  {candidate.rationale}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action button
// ---------------------------------------------------------------------------

interface ActionButtonProps {
  action: ReviewDecision;
  selected: boolean;
  disabled?: boolean;
  tooltipText?: string;
  onClick: () => void;
  label: string;
}

function ActionButton({ action, selected, disabled, tooltipText, onClick, label }: ActionButtonProps) {
  const isDestructive = action === 'block_from_submission';

  const baseClass = cn(
    'relative px-4 py-2 rounded-[8px] text-[13px] font-medium transition-all duration-150',
    'border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
  );

  const stateClass = selected
    ? isDestructive
      ? 'bg-[oklch(0.55_0.18_25)] text-white border-[oklch(0.55_0.18_25)]'
      : 'bg-[var(--accent)] text-white border-[var(--accent)]'
    : disabled
      ? 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink-3)] cursor-not-allowed opacity-60'
      : isDestructive
        ? 'border-[oklch(0.78_0.10_25)] bg-[oklch(0.97_0.025_25)] text-[oklch(0.45_0.16_25)] hover:bg-[oklch(0.55_0.18_25)] hover:text-white hover:border-[oklch(0.55_0.18_25)]'
        : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]';

  return (
    <div className="relative group">
      <button
        type="button"
        disabled={disabled}
        onClick={disabled ? undefined : onClick}
        className={cn(baseClass, stateClass)}
        aria-pressed={selected}
      >
        {label}
      </button>
      {disabled && tooltipText && (
        <div
          className={cn(
            'pointer-events-none absolute bottom-full mb-2 start-1/2 -translate-x-1/2',
            'w-[260px] px-3 py-2 rounded-[8px]',
            'bg-[oklch(0.18_0.01_250)] text-white text-[11.5px] leading-snug',
            'opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-20',
          )}
          role="tooltip"
        >
          {tooltipText}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// No props — id and batch_id are read from URL query params at runtime,
// matching the static-output Astro pattern used by TracePage.

type ActionKind = 'approve' | 'override' | 'reject' | 'block_from_submission';

export default function ReviewDetail() {
  const t = useT();

  const [id, setId] = useState('');
  const [batchId, setBatchId] = useState<string | null>(null);
  const [row, setRow] = useState<ReviewQueueRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Decision state
  const [selectedAction, setSelectedAction] = useState<ActionKind | null>(null);
  const [overrideCode, setOverrideCode] = useState('');
  const [overrideCodeError, setOverrideCodeError] = useState<string | null>(null);
  const [forceOverride, setForceOverride] = useState(false);
  const [selectedCandidateCode, setSelectedCandidateCode] = useState<string | null>(null);
  const [notes, setNotes] = useState('');

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitErrorKind, setSubmitErrorKind] = useState<
    'stale' | 'generic' | 'field' | 'highlight_candidates' | null
  >(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [showBlockModal, setShowBlockModal] = useState(false);

  const overrideInputRef = useRef<HTMLInputElement>(null);

  // Read id and batch_id from URL on mount (static-output Astro pattern).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setId(params.get('id') ?? '');
    setBatchId(params.get('batch_id'));
  }, []);

  // Fetch the review row.
  const fetchRow = () => {
    setLoading(true);
    setError(null);
    setNotFound(false);

    api
      .getReviewRow(id)
      .then((data) => {
        setRow(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
        } else {
          const msg =
            err instanceof ApiError
              ? `${err.status}: ${err.message}`
              : err instanceof Error
                ? err.message
                : 'Failed to load review row.';
          setError(msg);
        }
        setLoading(false);
      });
  };

  useEffect(() => { if (id) fetchRow(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // When action changes to 'override' and there's only one candidate,
  // auto-focus the override code input.
  useEffect(() => {
    if (selectedAction === 'override') {
      overrideInputRef.current?.focus();
    }
  }, [selectedAction]);

  // Candidate selection populates the override code input.
  function handleCandidateSelect(code: string) {
    setSelectedCandidateCode(code);
    setOverrideCode(code);
    setOverrideCodeError(null);
  }

  // Navigate back to the queue.
  function backToQueue() {
    const qs = batchId ? `?batch_id=${encodeURIComponent(batchId)}` : '';
    window.location.href = `/review${qs}`;
  }

  // Validate and submit the decision.
  async function submitDecision(confirmed = false) {
    if (!selectedAction) return;

    setOverrideCodeError(null);
    setSubmitError(null);
    setSubmitErrorKind(null);

    // Validate override code.
    if (selectedAction === 'override') {
      if (!CODE_RE.test(overrideCode)) {
        setOverrideCodeError(t('review_override_code_invalid'));
        return;
      }
    }

    // Block requires notes >= 10 chars.
    if (selectedAction === 'block_from_submission') {
      if (notes.trim().length < 10) {
        setSubmitError(t('review_detail_notes_required'));
        return;
      }
      // Show confirmation modal before proceeding.
      if (!confirmed) {
        setShowBlockModal(true);
        return;
      }
    }

    setSubmitting(true);

    try {
      let body: Parameters<typeof api.submitReviewDecision>[1];

      if (selectedAction === 'approve') {
        body = { decision: 'approve', ...(notes.trim() ? { reviewer_notes: notes.trim() } : {}) };
      } else if (selectedAction === 'override') {
        body = {
          decision: 'override',
          reviewer_code: overrideCode,
          ...(notes.trim() ? { reviewer_notes: notes.trim() } : {}),
          ...(forceOverride ? { force: true } : {}),
        };
      } else if (selectedAction === 'reject') {
        body = { decision: 'reject', ...(notes.trim() ? { reviewer_notes: notes.trim() } : {}) };
      } else {
        // block_from_submission
        body = { decision: 'block_from_submission', reviewer_notes: notes.trim() };
      }

      await api.submitReviewDecision(id, body);

      // Success toast.
      const successMsg =
        selectedAction === 'approve'
          ? t('review_success_approved')
          : selectedAction === 'override'
            ? t('review_success_overridden')
            : selectedAction === 'reject'
              ? t('review_success_rejected')
              : t('review_success_blocked');

      setToastMessage(successMsg);
      setShowBlockModal(false);

      setTimeout(() => {
        backToQueue();
      }, 1_000);
    } catch (err: unknown) {
      setSubmitting(false);
      setShowBlockModal(false);

      if (err instanceof ApiError) {
        if (err.status === 409) {
          setSubmitError(t('review_error_stale'));
          setSubmitErrorKind('stale');
          fetchRow();
          return;
        }
        if (err.status === 403) {
          setForceOverride(false);
          setSubmitErrorKind(null);
          // Auto-reveal force override section.
          setSelectedAction('override');
          setSubmitError(err.message);
          return;
        }
        if (err.status === 422) {
          const body = err.body as { code?: string } | null;
          if (body && typeof body === 'object' && body.code === 'reviewer_code_not_in_candidates') {
            setSubmitErrorKind('highlight_candidates');
            setSubmitError(err.message);
            return;
          }
        }
        if (err.status === 400) {
          const body = err.body as { details?: string } | null;
          setSubmitError(body?.details ?? err.message);
          setSubmitErrorKind('field');
          return;
        }
        setSubmitError(err.message);
        setSubmitErrorKind('generic');
      } else {
        setSubmitError(err instanceof Error ? err.message : 'Submission failed.');
        setSubmitErrorKind('generic');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const description = row
    ? typeof row.payload?.input === 'string'
      ? row.payload.input
      : row.item_id
    : '';

  const sortedCandidates: ReviewCandidate[] = row?.candidates
    ? [...row.candidates].sort((a, b) => b.rerank_score - a.rerank_score)
    : [];

  const canOverride = row?.can_override !== false;
  const canBlock = row?.can_block_from_submission !== false;

  const notesIsRequired = selectedAction === 'block_from_submission';
  const notesMinMet = !notesIsRequired || notes.trim().length >= 10;

  const submitDisabled =
    submitting ||
    !selectedAction ||
    (selectedAction === 'override' && !overrideCode) ||
    !notesMinMet;

  // Loading state.
  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <TopBar />
        <div className="max-w-[820px] mx-auto px-6 py-20 text-center">
          <div className="inline-flex items-center gap-2.5 text-[var(--ink-3)] text-[14px]">
            <span className="w-4 h-4 rounded-full border-2 border-[var(--line)] border-t-[var(--accent)] animate-spin" aria-hidden />
            {t('review_detail_loading')}
          </div>
        </div>
      </div>
    );
  }

  // 404 state.
  if (notFound) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <TopBar />
        <div className="max-w-[820px] mx-auto px-6 py-20 text-center space-y-4">
          <p className="text-[var(--ink-2)] text-[14px]">{t('review_detail_not_found')}</p>
          <button
            type="button"
            onClick={backToQueue}
            className={cn(
              'inline-flex items-center gap-1.5 px-4 py-2 rounded-[8px] text-[13px]',
              'border border-[var(--line)] bg-[var(--surface)]',
              'text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]',
              'transition-colors duration-150',
            )}
          >
            {t('review_back_to_queue')}
          </button>
        </div>
      </div>
    );
  }

  // General error.
  if (error) {
    return (
      <div className="min-h-screen bg-[var(--bg)]">
        <TopBar />
        <div className="max-w-[820px] mx-auto px-6 py-10">
          <div
            className="px-5 py-4 rounded-[10px] bg-[oklch(0.95_0.07_25)] border border-[oklch(0.88_0.08_25)] text-[13px] text-[oklch(0.35_0.14_25)]"
            role="alert"
          >
            {error}
          </div>
          <button
            type="button"
            onClick={backToQueue}
            className={cn(
              'mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-[8px] text-[13px]',
              'border border-[var(--line)] bg-[var(--surface)]',
              'text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]',
              'transition-colors duration-150',
            )}
          >
            {t('review_back_to_queue')}
          </button>
        </div>
      </div>
    );
  }

  if (!row) return null;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <TopBar />

      {/* Block confirmation modal */}
      {showBlockModal && (
        <BlockModal
          description={description}
          currentCode={row.current_final_code}
          notes={notes}
          t={t}
          onConfirm={() => { void submitDecision(true); }}
          onCancel={() => setShowBlockModal(false)}
          submitting={submitting}
        />
      )}

      {/* Toast */}
      {toastMessage && (
        <Toast message={toastMessage} onDone={() => setToastMessage(null)} />
      )}

      <main className="max-w-[820px] mx-auto px-6 py-10 space-y-6">

        {/* Breadcrumb + header */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <button
              type="button"
              onClick={backToQueue}
              className="font-mono text-[11px] tracking-[0.10em] uppercase text-[var(--ink-3)] hover:text-[var(--ink-2)] transition-colors"
            >
              {t('review_back_to_queue')}
            </button>
            <span className="text-[var(--line)]">›</span>
            <span className="font-mono text-[11px] tracking-[0.10em] uppercase text-[var(--ink-2)]">
              {row.reason === 'verdict_escalate'
                ? t('review_reason_verdict_escalate')
                : row.reason === 'sanity_flag'
                  ? t('review_reason_sanity_flag')
                  : row.reason === 'low_information'
                    ? t('review_reason_low_information')
                    : t('review_reason_verifier_uncertain')}
            </span>
          </div>

          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.015em] text-[var(--ink)] leading-snug">
            {description}
          </h1>

          <p className="mt-1 m-0 font-mono text-[12px] text-[var(--ink-3)]">
            {relativeTime(row.created_at)} · {row.item_id}
          </p>
        </div>

        {/* Pipeline state card */}
        <div className="bg-[var(--surface)] border border-[var(--line)] rounded-[10px] p-5 space-y-4">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            {row.current_final_code && (
              <div>
                <SectionLabel>{t('review_detail_current_code')}</SectionLabel>
                <span className="font-mono text-[17px] tracking-[0.01em] font-medium text-[var(--ink)]">
                  {row.current_final_code}
                </span>
              </div>
            )}

            {row.current_classification_confidence != null && (
              <div>
                <SectionLabel>{t('review_detail_confidence')}</SectionLabel>
                <span className="font-mono text-[17px] tracking-[0.01em] font-medium text-[var(--ink)]">
                  {Math.round(row.current_classification_confidence * 100)}%
                </span>
              </div>
            )}

            {row.current_sanity_verdict && (
              <div>
                <SectionLabel>{t('review_detail_sanity')}</SectionLabel>
                <MetaPill className="bg-[oklch(0.93_0.06_55)] text-[oklch(0.40_0.12_55)]">
                  {row.current_sanity_verdict}
                </MetaPill>
              </div>
            )}
          </div>

          {row.current_sanity_rationale && (
            <p className="m-0 text-[12.5px] text-[var(--ink-2)] leading-relaxed italic">
              {row.current_sanity_rationale}
            </p>
          )}
        </div>

        {/* Candidates */}
        {sortedCandidates.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <SectionLabel>{t('review_detail_candidates')}</SectionLabel>
              <span className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.06em] uppercase">
                · {t('review_detail_candidates_sorted')}
              </span>
            </div>

            {submitErrorKind === 'highlight_candidates' && (
              <div
                className="mb-3 px-4 py-3 rounded-[8px] bg-[oklch(0.95_0.07_55)] border border-[oklch(0.85_0.10_55)] text-[12.5px] text-[oklch(0.38_0.12_55)]"
                role="alert"
              >
                {submitError} — pick a code from the list below, or use force override.
              </div>
            )}

            <div className="space-y-2">
              {sortedCandidates.map((candidate, i) => (
                <CandidateRow
                  key={candidate.code}
                  candidate={candidate}
                  index={i}
                  isSelected={selectedCandidateCode === candidate.code}
                  radioEnabled={selectedAction === 'override'}
                  onSelect={handleCandidateSelect}
                  t={t}
                />
              ))}
            </div>
          </div>
        )}

        {/* Action bar */}
        <div className="bg-[var(--surface)] border border-[var(--line)] rounded-[10px] p-5 space-y-5">
          <div className="flex flex-wrap gap-2.5">
            <ActionButton
              action="approve"
              selected={selectedAction === 'approve'}
              onClick={() => setSelectedAction('approve')}
              label={t('review_action_approve')}
            />

            <ActionButton
              action="override"
              selected={selectedAction === 'override'}
              disabled={!canOverride && !forceOverride}
              tooltipText={!canOverride ? t('review_override_high_conf_tooltip') : undefined}
              onClick={() => {
                if (!canOverride && !forceOverride) {
                  // Clicking disabled override opens force-override disclosure.
                  setSelectedAction('override');
                  return;
                }
                setSelectedAction('override');
              }}
              label={t('review_action_override')}
            />

            <ActionButton
              action="reject"
              selected={selectedAction === 'reject'}
              onClick={() => setSelectedAction('reject')}
              label={t('review_action_reject')}
            />

            {canBlock && (
              <ActionButton
                action="block_from_submission"
                selected={selectedAction === 'block_from_submission'}
                onClick={() => setSelectedAction('block_from_submission')}
                label={t('review_action_block')}
              />
            )}
          </div>

          {/* Override code input */}
          {selectedAction === 'override' && (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="override-code"
                  className="block font-mono text-[10.5px] tracking-[0.10em] uppercase text-[var(--ink-3)] mb-1.5"
                >
                  {t('review_override_code_label')}
                </label>
                <input
                  ref={overrideInputRef}
                  id="override-code"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{12}"
                  maxLength={12}
                  value={overrideCode}
                  disabled={!canOverride && !forceOverride}
                  onChange={(e) => {
                    setOverrideCode(e.target.value.replace(/\D/g, ''));
                    setOverrideCodeError(null);
                  }}
                  placeholder={t('review_override_code_placeholder')}
                  className={cn(
                    'w-full max-w-[220px] px-3 py-2 rounded-[8px]',
                    'border bg-[var(--bg)] font-mono text-[14px] tracking-[0.04em]',
                    'text-[var(--ink)] placeholder:text-[var(--ink-3)]',
                    'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                    'transition-colors duration-150',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    overrideCodeError
                      ? 'border-[oklch(0.65_0.18_25)]'
                      : 'border-[var(--line)] hover:border-[var(--ink-3)]',
                  )}
                />
                {overrideCodeError && (
                  <p className="mt-1 m-0 text-[12px] text-[oklch(0.45_0.18_25)]" role="alert">
                    {overrideCodeError}
                  </p>
                )}
              </div>

              {/* Force override disclosure */}
              <div className="rounded-[8px] border border-[var(--line-2)] bg-[var(--bg)] p-3.5">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={forceOverride}
                    onChange={(e) => setForceOverride(e.target.checked)}
                    className="mt-0.5 accent-[var(--accent)] w-4 h-4 flex-shrink-0 cursor-pointer"
                  />
                  <div>
                    <span className="block text-[13px] font-medium text-[var(--ink-2)]">
                      {t('review_override_force_label')}
                    </span>
                    <span className="block mt-0.5 text-[12px] text-[var(--ink-3)] leading-snug">
                      {t('review_override_force_hint')}
                    </span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Notes textarea */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="reviewer-notes"
                className="font-mono text-[10.5px] tracking-[0.10em] uppercase text-[var(--ink-3)]"
              >
                {t('review_detail_notes_label')}
                {notesIsRequired && (
                  <span className="ms-1 text-[oklch(0.50_0.18_25)]">*</span>
                )}
              </label>
              {notesIsRequired && (
                <span className="font-mono text-[10.5px] text-[var(--ink-3)]">
                  {notes.trim().length} {t('review_detail_notes_chars')}
                </span>
              )}
            </div>
            <textarea
              id="reviewer-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                notesIsRequired
                  ? t('review_detail_notes_required')
                  : t('review_detail_notes_placeholder')
              }
              className={cn(
                'w-full px-3 py-2 rounded-[8px]',
                'border border-[var(--line)] hover:border-[var(--ink-3)]',
                'bg-[var(--bg)] text-[13px] text-[var(--ink)] leading-relaxed',
                'placeholder:text-[var(--ink-3)]',
                'focus:outline-none focus:ring-2 focus:ring-[var(--accent)]',
                'resize-y transition-colors duration-150',
              )}
            />
          </div>

          {/* Submit error banner */}
          {submitError && submitErrorKind !== 'highlight_candidates' && (
            <div
              className="px-4 py-3 rounded-[8px] bg-[oklch(0.95_0.07_25)] border border-[oklch(0.88_0.08_25)] text-[12.5px] text-[oklch(0.35_0.14_25)]"
              role="alert"
            >
              {submitError}
            </div>
          )}

          {/* Submit button */}
          <button
            type="button"
            disabled={submitDisabled}
            onClick={() => { void submitDecision(); }}
            className={cn(
              'px-6 py-2.5 rounded-[8px] text-[13.5px] font-semibold text-white',
              'bg-[var(--accent)] border border-[var(--accent)]',
              'hover:brightness-110 transition-[filter] duration-150',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:brightness-100',
            )}
          >
            {submitting ? '…' : selectedAction === 'approve'
              ? t('review_action_approve')
              : selectedAction === 'override'
                ? t('review_action_override')
                : selectedAction === 'reject'
                  ? t('review_action_reject')
                  : selectedAction === 'block_from_submission'
                    ? t('review_action_block')
                    : 'Submit'}
          </button>
        </div>
      </main>
    </div>
  );
}
