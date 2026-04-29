/**
 * TracePage.tsx — operator audit + end-user feedback for one classification.
 *
 * The page tells the story of a single /classify/describe request as a
 * stack of stage blocks (cleanup → retrieval → research → gate →
 * picker → best-effort), preceded by a header band and a one-line
 * spine that summarises the flow at a glance, followed by the
 * candidates / feedback / raw-JSON sections.
 *
 * URL: /trace?id=<uuid>. The page reads the UUID from the query string
 * at hydration so the static build can ship one HTML file that serves
 * every UUID — see pages/trace/index.astro for the routing rationale.
 *
 * AUTH (per ADR-0017): anyone with the URL can view + leave feedback.
 * UUIDs are unguessable; the trace is "your own request" by
 * construction.
 *
 * COMPOSITION:
 *   <TracePage>
 *     ├── <Header>             — endpoint, latency, decision pill
 *     ├── <TraceSpine>         — at-a-glance flow strip (6 pills)
 *     ├── 6 × <StageBlock>     — per-stage cards rendered from adapters
 *     ├── <FeedbackBlock>      — three-way feedback form (carried over)
 *     └── <RawJsonBlock>       — collapsed full event payload (carried over)
 */
import { useEffect, useMemo, useState } from 'react';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  api,
  ApiError,
  type TraceResponse,
  type TraceEvent,
  type TraceFeedback,
  type FeedbackKind,
} from '@/lib/api';
import {
  StageBlock,
  StageSection,
  StageDecision,
  StageHandoff,
  StageRaw,
  StageChecks,
  type CheckState,
} from './trace/StageBlock';
import { TraceSpine, type SpinePillSpec } from './trace/TraceSpine';
import {
  RetrievalFunnel,
  type AltRow,
  type MethodInfo,
} from './trace/RetrievalFunnel';
import RequiredProcedures from './RequiredProcedures';

/* ────────────────────────────────────────────────────────────── */
/*  Backend-shape narrowing                                       */
/* ────────────────────────────────────────────────────────────── */

interface ModelCall {
  stage: string;
  model: string;
  latency_ms: number;
  status: 'ok' | 'timeout' | 'error' | string;
}
function isModelCallArray(v: unknown): v is ModelCall[] {
  return (
    Array.isArray(v) &&
    v.every((x) => typeof x === 'object' && x !== null && 'stage' in x && 'latency_ms' in x)
  );
}
function isAlternativeArray(v: unknown): v is AltRow[] {
  return (
    Array.isArray(v) &&
    v.every((x) => typeof x === 'object' && x !== null && 'code' in x)
  );
}

/* ────────────────────────────────────────────────────────────── */
/*  Display helpers                                               */
/* ────────────────────────────────────────────────────────────── */

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}
function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function fmtScore(n: number | null | undefined): string {
  return n == null ? '—' : n.toFixed(2);
}
function resolveEventId(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('id') ?? '';
}

/* ────────────────────────────────────────────────────────────── */
/*  Stage adapters                                                */
/*                                                                */
/*  Each adapter takes the event + helpers and returns the JSX    */
/*  payload for one StageBlock. Adapters return `null` when the   */
/*  stage didn't run (its model_call wasn't logged) — TracePage   */
/*  filters those out so the timeline only shows what happened.   */
/* ────────────────────────────────────────────────────────────── */

interface StageRender {
  /** id used for #anchor scroll-to and the spine pill href. */
  id: string;
  /** Spine pill description. */
  spine: Omit<SpinePillSpec, 'href'>;
  /** Full <StageBlock /> JSX for the body. */
  node: React.ReactElement;
}

type T = (key: TKey) => string;
type StageAdapterCtx = {
  event: TraceEvent;
  call?: ModelCall;
  candidates: AltRow[];
  /** Index in the rendered timeline (1-based). */
  index: number;
  /** Total number of stages rendered (for "Stage N / total"). */
  total: number;
  /** Resolves the next-rendered stage's title for the handoff pill. */
  nextLabel?: string;
  /** Anchor for the next stage's link target. */
  nextHref?: string;
  /** i18n hook. */
  t: T;
};

function adaptCleanup(ctx: StageAdapterCtx): StageRender | null {
  const { event, call, t, index, total, nextHref, nextLabel } = ctx;
  // Cleanup is optional — only render if it was called.
  if (!call) return null;
  return {
    id: 'stage-cleanup',
    spine: { num: String(index), label: 'Cleanup', meta: fmtMs(call.latency_ms), state: 'good' },
    node: (
      <StageBlock
        key="cleanup"
        id="stage-cleanup"
        index={index}
        total={total}
        title={t('t2_cleanup_title')}
        state={call.status === 'ok' ? 'good' : 'bad'}
        stateLabel={t(call.status === 'ok' ? 't2_state_ok' : 't2_state_failed')}
        meta={fmtMs(call.latency_ms)}
      >
        <StageSection
          label={t('t2_section_what_does')}
          labelExtra={<ModelChip model={call.model} />}
        >
          {t('t2_cleanup_what')}
        </StageSection>

        <StageSection label={t('t2_section_input')}>
          <span className="text-[var(--ink)]">{requestText(event)}</span>
        </StageSection>

        {nextHref && nextLabel && (
          <StageSection label={t('t2_section_next')}>
            <StageHandoff
              href={nextHref}
              label={t('t2_continues_at')
                .replace('{n}', String(index + 1))
                .replace('{label}', nextLabel)}
            />
          </StageSection>
        )}

        <StageRaw data={call} showLabel={t('t2_show_raw')} hideLabel={t('t2_hide_raw')} />
      </StageBlock>
    ),
  };
}

function adaptResearch(ctx: StageAdapterCtx): StageRender | null {
  const { call, t, index, total, nextHref, nextLabel } = ctx;
  if (!call) return null;
  return {
    id: 'stage-research',
    spine: { num: String(index), label: 'Research', meta: fmtMs(call.latency_ms), state: 'good' },
    node: (
      <StageBlock
        key="research"
        id="stage-research"
        index={index}
        total={total}
        title={t('t2_research_title')}
        state={call.status === 'ok' ? 'good' : 'bad'}
        stateLabel={t(call.status === 'ok' ? 't2_state_ok' : 't2_state_failed')}
        meta={fmtMs(call.latency_ms)}
      >
        <StageSection
          label={t('t2_section_what_does')}
          labelExtra={<ModelChip model={call.model} />}
        >
          {t('t2_research_what')}
        </StageSection>
        {nextHref && nextLabel && (
          <StageSection label={t('t2_section_next')}>
            <StageHandoff
              href={nextHref}
              label={t('t2_continues_at')
                .replace('{n}', String(index + 1))
                .replace('{label}', nextLabel)}
            />
          </StageSection>
        )}
        <StageRaw data={call} showLabel={t('t2_show_raw')} hideLabel={t('t2_hide_raw')} />
      </StageBlock>
    ),
  };
}

function adaptRetrieval(ctx: StageAdapterCtx): StageRender {
  const { event, t, index, total, candidates, nextHref, nextLabel } = ctx;
  const top = event.top_retrieval_score;
  const gap = event.top2_gap;
  const count = event.candidate_count;
  // Build the 3 method cards with what we have. Per-method counts
  // aren't on the current backend payload — qualitative funnel for now.
  const methods: [MethodInfo, MethodInfo, MethodInfo] = [
    {
      name: t('t2_retrieval_method_vectors'),
      description: t('t2_retrieval_method_vectors_desc'),
      latencyMs: null, top1: null, returned: 50,
    },
    {
      name: t('t2_retrieval_method_bm25'),
      description: t('t2_retrieval_method_bm25_desc'),
      latencyMs: null, top1: null, returned: 50,
    },
    {
      name: t('t2_retrieval_method_trigram'),
      description: t('t2_retrieval_method_trigram_desc'),
      latencyMs: null, top1: null, returned: 50,
    },
  ];

  return {
    id: 'stage-retrieval',
    spine: {
      num: String(index),
      label: 'Search',
      meta: count != null ? `${count} candidates` : undefined,
      state: 'good',
    },
    node: (
      <StageBlock
        key="retrieval"
        id="stage-retrieval"
        index={index}
        total={total}
        title={t('t2_retrieval_title')}
        titleGloss={t('t2_glossary_rrf')}
        state="good"
        stateLabel={count != null ? `${count}` : t('t2_state_ok')}
      >
        <StageSection label={t('t2_section_what_does')}>
          {t('t2_retrieval_what')}
        </StageSection>

        <StageSection label={t('t2_retrieval_query_label')}>
          <strong className="text-[var(--ink)]">{requestText(event)}</strong>
        </StageSection>

        <StageSection label={t('t2_retrieval_methods_label')}>
          <RetrievalFunnel
            methods={methods}
            candidates={candidates}
            finalCount={count ?? candidates.length}
            top2Gap={gap}
          />
        </StageSection>

        <StageSection label={t('t2_retrieval_signal_label')}>
          <StageChecks rows={signalChecks(t, top, gap, count)} />
        </StageSection>

        {nextHref && nextLabel && (
          <StageSection label={t('t2_section_next')}>
            <span className="block mb-1.5">{t('t2_retrieval_next')}</span>
            <StageHandoff
              href={nextHref}
              label={t('t2_continues_at')
                .replace('{n}', String(index + 1))
                .replace('{label}', nextLabel)}
            />
          </StageSection>
        )}

        <StageRaw
          data={{
            embedder_version: event.embedder_version,
            candidate_count: count,
            top_retrieval_score: top,
            top2_gap: gap,
          }}
          showLabel={t('t2_show_raw')}
          hideLabel={t('t2_hide_raw')}
        />
      </StageBlock>
    ),
  };
}

/**
 * Evidence gate — always runs. Three checks; tone depends on which
 * (if any) failed. The spec table:
 *   - All pass     → good (proceeded to picker)
 *   - Top-2 gap tight, others pass → warn (flagged but didn't refuse)
 *   - Anything else fails  → bad (refused)
 */
function adaptGate(ctx: StageAdapterCtx): StageRender {
  const { event, t, index, total, nextHref, nextLabel } = ctx;
  const top = event.top_retrieval_score;
  const gap = event.top2_gap;
  const count = event.candidate_count;
  const TOP_MIN = 0.4, GAP_MIN = 0.05, COUNT_MIN = 3;

  const topPass   = top != null && top >= TOP_MIN;
  const gapPass   = gap != null && gap >= GAP_MIN;
  const countPass = count != null && count >= COUNT_MIN;
  const allPass = topPass && gapPass && countPass;
  const onlyGapFailed = topPass && !gapPass && countPass;

  const blockState: 'good' | 'warn' | 'bad' = allPass ? 'good' : onlyGapFailed ? 'warn' : 'bad';
  const stateLabelKey: TKey = allPass ? 't2_state_ok' : onlyGapFailed ? 't2_state_warned' : 't2_state_refused';

  // Tone of the decision callout matches the block state.
  const decisionTitleKey: TKey = allPass
    ? 't2_gate_decision_pass_title'
    : onlyGapFailed
      ? 't2_gate_decision_warn_title'
      : 't2_gate_decision_fail_title';
  const decisionBodyKey: TKey = allPass
    ? 't2_gate_decision_pass_body'
    : onlyGapFailed
      ? 't2_gate_decision_warn_body'
      : 't2_gate_decision_fail_body';
  const nextKey: TKey = allPass
    ? 't2_gate_next_pass'
    : onlyGapFailed
      ? 't2_gate_next_warn'
      : 't2_gate_next_fail';

  return {
    id: 'stage-gate',
    spine: {
      num: String(index),
      label: 'Gate',
      meta: allPass ? 'passed' : onlyGapFailed ? 'tight' : 'refused',
      state: blockState,
    },
    node: (
      <StageBlock
        key="gate"
        id="stage-gate"
        index={index}
        total={total}
        title={t('t2_gate_title')}
        titleGloss={t('t2_glossary_gate')}
        state={blockState}
        stateLabel={t(stateLabelKey)}
      >
        <StageSection label={t('t2_section_what_does')}>
          {t('t2_gate_what')}
        </StageSection>

        <StageSection label={t('t2_gate_thresholds_label')}>
          <StageChecks
            rows={[
              {
                state: topPass ? 'pass' : 'fail',
                label: t('t2_gate_top_label').replace('{score}', fmtScore(top)),
                rule: t('t2_gate_top_rule').replace('{min}', String(TOP_MIN)),
              },
              {
                state: gapPass ? 'pass' : 'fail',
                label: t('t2_gate_gap_label').replace('{gap}', fmtScore(gap)),
                rule: t('t2_gate_gap_rule').replace('{min}', String(GAP_MIN)),
              },
              {
                state: countPass ? 'pass' : 'fail',
                label: t('t2_gate_count_label').replace('{n}', String(count ?? '—')),
                rule: t('t2_gate_count_rule').replace('{min}', String(COUNT_MIN)),
              },
            ]}
          />
        </StageSection>

        <StageSection label={t('t2_section_decision')}>
          <StageDecision tone={blockState} title={t(decisionTitleKey)}>
            {t(decisionBodyKey)}
          </StageDecision>
        </StageSection>

        {nextHref && nextLabel && (
          <StageSection label={t('t2_section_next')}>
            <span className="block mb-1.5">{t(nextKey)}</span>
            <StageHandoff
              href={nextHref}
              label={t('t2_continues_at')
                .replace('{n}', String(index + 1))
                .replace('{label}', nextLabel)}
            />
          </StageSection>
        )}

        <StageRaw
          data={{
            thresholds: { min_top_score: TOP_MIN, min_top2_gap: GAP_MIN, min_candidates: COUNT_MIN },
            observed: { top_score: top, top2_gap: gap, candidate_count: count },
            passed: { top: topPass, gap: gapPass, count: countPass },
          }}
          showLabel={t('t2_show_raw')}
          hideLabel={t('t2_hide_raw')}
        />
      </StageBlock>
    ),
  };
}

function adaptPicker(ctx: StageAdapterCtx): StageRender | null {
  const { event, call, t, index, total, nextHref, nextLabel } = ctx;
  if (!call) return null;
  const guarded = event.guard_tripped;
  const chosen = event.chosen_code;
  const blockState: 'good' | 'warn' | 'bad' =
    guarded ? 'bad' : chosen ? 'good' : 'warn';

  return {
    id: 'stage-picker',
    spine: {
      num: String(index),
      label: 'Picker',
      meta: fmtMs(call.latency_ms),
      state: blockState,
    },
    node: (
      <StageBlock
        key="picker"
        id="stage-picker"
        index={index}
        total={total}
        title={t('t2_picker_title')}
        titleGloss={t('t2_glossary_picker')}
        state={blockState}
        stateLabel={
          guarded ? t('t2_state_failed')
            : chosen ? t('t2_state_ok')
              : t('t2_state_skipped')
        }
        meta={fmtMs(call.latency_ms)}
      >
        <StageSection
          label={t('t2_section_what_does')}
          labelExtra={<ModelChip model={call.model} />}
        >
          {t('t2_picker_what')}
        </StageSection>

        {chosen && !guarded && (
          <StageSection label={t('t2_picker_chose_label')}>
            <code className="font-mono text-[14px] text-[var(--ink)] font-medium">{chosen}</code>
          </StageSection>
        )}

        {event.rationale && (
          <StageSection label={t('t2_picker_why_label')}>
            <blockquote
              className="border-s-[3px] border-[var(--accent)] bg-[var(--accent-soft)] ps-3.5 py-1.5 m-0 rounded-e-[var(--radius)] text-[13.5px] leading-[1.6] text-[var(--ink-2)]"
            >
              {event.rationale}
            </blockquote>
          </StageSection>
        )}

        <StageSection label={t('t2_picker_checks_label')}>
          <StageChecks rows={pickerChecks(t, guarded)} />
        </StageSection>

        <StageSection label={t('t2_section_decision')}>
          {guarded ? (
            <StageDecision tone="bad" title={t('t2_picker_decision_guarded_title')}>
              {t('t2_picker_decision_guarded_body')}
            </StageDecision>
          ) : chosen ? (
            <StageDecision tone="good" title={t('t2_picker_decision_accepted_title')}>
              {t('t2_picker_decision_accepted_body').replace('{code}', chosen)}
            </StageDecision>
          ) : (
            <StageDecision tone="warn" title={t('t2_picker_decision_skipped_title')}>
              {t('t2_picker_decision_skipped_body')}
            </StageDecision>
          )}
        </StageSection>

        {nextHref && nextLabel && (
          <StageSection label={t('t2_section_next')}>
            <span className="block mb-1.5">
              {chosen && !guarded ? t('t2_picker_next') : t('t2_picker_next_skipped')}
            </span>
            <StageHandoff
              href={nextHref}
              label={t('t2_continues_at')
                .replace('{n}', String(index + 1))
                .replace('{label}', nextLabel)}
            />
          </StageSection>
        )}

        <StageRaw data={call} showLabel={t('t2_show_raw')} hideLabel={t('t2_hide_raw')} />
      </StageBlock>
    ),
  };
}

function adaptBestEffort(ctx: StageAdapterCtx): StageRender | null {
  const { event, call, t, index, total } = ctx;
  if (!call) return null;
  return {
    id: 'stage-best-effort',
    spine: {
      num: String(index),
      label: 'Best-effort',
      meta: fmtMs(call.latency_ms),
      state: 'warn',
    },
    node: (
      <StageBlock
        key="best_effort"
        id="stage-best-effort"
        index={index}
        total={total}
        title={t('t2_best_effort_title')}
        titleGloss={t('t2_glossary_best_effort')}
        state="warn"
        stateLabel={t('t2_state_ok')}
        meta={fmtMs(call.latency_ms)}
      >
        <StageSection
          label={t('t2_section_what_does')}
          labelExtra={<ModelChip model={call.model} />}
        >
          {t('t2_best_effort_what')}
        </StageSection>

        {event.chosen_code && (
          <StageSection label={t('t2_best_effort_outcome_label')}>
            <StageDecision tone="warn" title={t('t2_state_ok')}>
              {t('t2_best_effort_outcome_body')
                .replace('{code}', event.chosen_code)
                .replace('{reason}', event.decision_reason)}
            </StageDecision>
          </StageSection>
        )}

        <StageRaw data={call} showLabel={t('t2_show_raw')} hideLabel={t('t2_hide_raw')} />
      </StageBlock>
    ),
  };
}

/* ────────────────────────────────────────────────────────────── */
/*  Small inline components used across adapters                  */
/* ────────────────────────────────────────────────────────────── */

function ModelChip({ model }: { model: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--line-2)] border border-[var(--line)] font-mono text-[10.5px] text-[var(--ink-3)]">
      {model}
    </span>
  );
}

function requestText(e: TraceEvent): string {
  if (typeof e.request === 'object' && e.request !== null && 'description' in e.request) {
    return String((e.request as { description?: unknown }).description ?? '');
  }
  return '';
}

function signalChecks(
  t: T,
  top: number | null,
  gap: number | null,
  count: number | null,
): Array<{ state: CheckState; label: React.ReactNode; rule?: string }> {
  return [
    {
      state: (top != null && top >= 0.4) ? 'pass' : 'warn',
      label: t('t2_retrieval_signal_top_label').replace('{score}', fmtScore(top)),
      rule: t(top != null && top >= 0.4 ? 't2_retrieval_signal_top_strong' : 't2_retrieval_signal_top_weak'),
    },
    {
      state: (gap != null && gap >= 0.05) ? 'pass' : 'warn',
      label: t('t2_retrieval_signal_gap_label').replace('{gap}', fmtScore(gap)),
      rule: t(gap != null && gap >= 0.05 ? 't2_retrieval_signal_gap_strong' : 't2_retrieval_signal_gap_tight'),
    },
    {
      state: (count != null && count >= 3) ? 'pass' : 'warn',
      label: t('t2_retrieval_signal_count_label').replace('{n}', String(count ?? '—')),
      rule: t(count != null && count >= 3 ? 't2_retrieval_signal_count_healthy' : 't2_retrieval_signal_count_thin'),
    },
  ];
}

function pickerChecks(
  t: T,
  guarded: boolean,
): Array<{ state: CheckState; label: React.ReactNode; rule?: string }> {
  return [
    {
      state: guarded ? 'fail' : 'pass',
      label: t('t2_picker_check_in_set'),
      rule: t('t2_picker_check_in_set_rule'),
    },
    {
      state: 'pass',
      label: t('t2_picker_check_schema'),
      rule: t('t2_picker_check_schema_rule'),
    },
  ];
}

/* ────────────────────────────────────────────────────────────── */
/*  Feedback block (carried over from the previous TracePage)     */
/* ────────────────────────────────────────────────────────────── */

type FbMode = 'idle' | 'reject' | 'prefer' | 'submitted_confirm';

function FeedbackBlock({
  feedback, chosenCode, alternatives, onSubmit,
}: {
  feedback: TraceFeedback[];
  chosenCode: string | null;
  alternatives: AltRow[];
  onSubmit: (kind: FeedbackKind, body: { reason?: string; corrected_code?: string; rejected_code?: string }) => Promise<void>;
}) {
  const t = useT();
  const [mode, setMode] = useState<FbMode>('idle');
  const [reason, setReason] = useState('');
  const [correctedCode, setCorrectedCode] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode('idle'); setReason(''); setCorrectedCode(''); setCustomCode(''); setError(null);
  };
  const validateReject = (): string | null => {
    if (reason.trim().length < 10) return t('fb_err_reason_too_short');
    return null;
  };
  const validatePrefer = (): string | null => {
    if (reason.trim().length < 10) return t('fb_err_reason_too_short');
    const code = (customCode.trim() || correctedCode.trim());
    if (!code) return t('fb_err_corrected_required');
    if (!/^\d{12}$/.test(code)) return t('fb_err_corrected_invalid');
    return null;
  };
  const fireSubmit = async (kind: FeedbackKind, body: Parameters<typeof onSubmit>[1]) => {
    setSubmitting(true); setError(null);
    try { await onSubmit(kind, body); reset(); }
    catch (e) { setError(e instanceof ApiError ? `${e.status}: ${e.message}` : t('err_generic')); }
    finally { setSubmitting(false); }
  };
  const fbHistory = feedback.length === 0 ? null : feedback;

  return (
    <div className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] p-4 flex flex-col gap-3">
      <div className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase">{t('fb_history_title')}</div>
      {fbHistory ? (
        <ul className="text-[12.5px] text-[var(--ink-2)] flex flex-col gap-1">
          {fbHistory.map((f) => (
            <li key={f.id}>
              <span className="font-mono text-[var(--ink-3)]">{fmtDate(f.created_at)}</span>{' · '}
              <span>
                {f.kind === 'confirm' && t('fb_kind_confirm')}
                {f.kind === 'reject' && t('fb_kind_reject')}
                {f.kind === 'prefer_alternative' && t('fb_kind_prefer')}
              </span>
              {f.corrected_code && <> → <span className="font-mono">{f.corrected_code}</span></>}
              {f.reason && <span className="text-[var(--ink-3)] italic"> · {f.reason}</span>}
            </li>
          ))}
        </ul>
      ) : (<div className="text-[12.5px] text-[var(--ink-3)] italic">{t('fb_history_none')}</div>)}

      <div className="pt-2 border-t border-[var(--line-2)]">
        {mode === 'idle' && (
          <>
            <div className="text-[14px] text-[var(--ink-2)] mb-2.5">{t('fb_default_prompt')}</div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={submitting || !chosenCode} onClick={() => fireSubmit('confirm', {})}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[12.5px] font-medium text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150">
                {t('fb_confirm')}
              </button>
              <button type="button" disabled={submitting || !chosenCode} onClick={() => setMode('reject')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[12.5px] font-medium text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)] disabled:opacity-50 transition-colors duration-150">
                {t('fb_reject')}
              </button>
              <button type="button" disabled={submitting} onClick={() => setMode('prefer')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[12.5px] font-medium text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)] disabled:opacity-50 transition-colors duration-150">
                {t('fb_prefer')}
              </button>
            </div>
          </>
        )}

        {mode === 'reject' && (
          <form onSubmit={(e) => {
              e.preventDefault();
              const v = validateReject(); if (v) { setError(v); return; }
              fireSubmit('reject', { reason: reason.trim(), rejected_code: chosenCode ?? undefined });
            }}
            className="flex flex-col gap-2"
          >
            <label className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase">{t('fb_reason_label')}</label>
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder={t('fb_reason_placeholder')}
              className="w-full px-3 py-2 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--line-2)] text-[14px] text-[var(--ink)] outline-none focus:border-[var(--ink-3)] resize-none" />
            {error && <div className="text-[12.5px] text-[oklch(0.55_0.18_25)]">{error}</div>}
            <div className="flex gap-2">
              <button type="submit" disabled={submitting}
                className="px-3 py-1.5 rounded-full bg-[var(--accent)] text-white text-[12.5px] font-medium disabled:opacity-50">
                {submitting ? t('fb_submitting') : t('fb_submit')}
              </button>
              <button type="button" disabled={submitting} onClick={reset}
                className="px-3 py-1.5 rounded-full border border-[var(--line)] text-[12.5px] text-[var(--ink-2)]">
                {t('fb_cancel')}
              </button>
            </div>
          </form>
        )}

        {mode === 'prefer' && (
          <form onSubmit={(e) => {
              e.preventDefault();
              const v = validatePrefer(); if (v) { setError(v); return; }
              const code = customCode.trim() || correctedCode.trim();
              fireSubmit('prefer_alternative', {
                reason: reason.trim(),
                rejected_code: chosenCode ?? undefined,
                corrected_code: code,
              });
            }}
            className="flex flex-col gap-2.5"
          >
            {alternatives.length > 0 && (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-1">
                  {t('fb_pick_from_candidates')}
                </legend>
                {alternatives.map((a) => (
                  <label key={a.code}
                    className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius)] border border-[var(--line)] hover:border-[var(--ink-3)] cursor-pointer text-[13px]">
                    <input type="radio" name="corrected" value={a.code}
                      checked={correctedCode === a.code}
                      onChange={() => { setCorrectedCode(a.code); setCustomCode(''); }} />
                    <span className="font-mono text-[var(--ink)]">{a.code}</span>
                    <span className="text-[var(--ink-2)] truncate">{a.description_en}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <label className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase">{t('fb_or_enter_custom')}</label>
            <input type="text" inputMode="numeric" value={customCode}
              onChange={(e) => { setCustomCode(e.target.value.replace(/\D/g, '').slice(0, 12)); if (e.target.value) setCorrectedCode(''); }}
              placeholder={t('fb_custom_placeholder')}
              className="px-3 py-2 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--line-2)] font-mono text-[14px] text-[var(--ink)] outline-none focus:border-[var(--ink-3)]" />
            <label className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase">{t('fb_reason_label')}</label>
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder={t('fb_reason_placeholder')}
              className="w-full px-3 py-2 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--line-2)] text-[14px] text-[var(--ink)] outline-none focus:border-[var(--ink-3)] resize-none" />
            {error && <div className="text-[12.5px] text-[oklch(0.55_0.18_25)]">{error}</div>}
            <div className="flex gap-2">
              <button type="submit" disabled={submitting}
                className="px-3 py-1.5 rounded-full bg-[var(--accent)] text-white text-[12.5px] font-medium disabled:opacity-50">
                {submitting ? t('fb_submitting') : t('fb_submit')}
              </button>
              <button type="button" disabled={submitting} onClick={reset}
                className="px-3 py-1.5 rounded-full border border-[var(--line)] text-[12.5px] text-[var(--ink-2)]">
                {t('fb_cancel')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/*  RawJsonBlock (carried over)                                   */
/* ────────────────────────────────────────────────────────────── */

function RawJsonBlock({ data, copyLabel, copiedLabel }: { data: TraceResponse; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="px-4 pb-4">
      <button type="button" onClick={copy}
        className="mb-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[var(--line)] bg-[var(--surface)] text-[12px] text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-colors duration-150"
      >{copied ? copiedLabel : copyLabel}</button>
      <pre className="p-3 rounded-[var(--radius)] bg-[var(--line-2)] border border-[var(--line)] text-[11.5px] font-mono text-[var(--ink-2)] overflow-x-auto leading-[1.55]">{text}</pre>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/*  Page                                                          */
/* ────────────────────────────────────────────────────────────── */

export default function TracePage() {
  const t = useT();
  const [eventId] = useState<string>(() => resolveEventId());
  const [data, setData] = useState<TraceResponse | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const refresh = async () => {
    if (!eventId) { setLoadState('not_found'); return; }
    setLoadState('loading');
    try {
      const res = await api.trace(eventId);
      setData(res); setLoadState('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) { setLoadState('not_found'); return; }
      setErrorMsg(err instanceof Error ? err.message : t('err_generic'));
      setLoadState('error');
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [eventId]);

  if (loadState === 'loading') {
    return (
      <main className="max-w-[920px] mx-auto px-7 pt-12 pb-12">
        <div className="text-[14px] text-[var(--ink-3)]">{t('trace_loading')}</div>
      </main>
    );
  }
  if (loadState === 'not_found') {
    return (
      <main className="max-w-[920px] mx-auto px-7 pt-12 pb-12">
        <div className="text-[14px] text-[var(--ink-2)]">{t('trace_not_found')}</div>
        <a href="/" className="mt-4 inline-block text-[13px] text-[var(--accent)] hover:underline">{t('trace_back')}</a>
      </main>
    );
  }
  if (loadState === 'error' || !data) {
    return (
      <main className="max-w-[920px] mx-auto px-7 pt-12 pb-12">
        <div className="text-[14px] text-[var(--ink-2)]">{t('trace_error')}</div>
        {errorMsg && <div className="mt-2 text-[12.5px] text-[var(--ink-3)] font-mono">{errorMsg}</div>}
        <a href="/" className="mt-4 inline-block text-[13px] text-[var(--accent)] hover:underline">{t('trace_back')}</a>
      </main>
    );
  }

  const { event, feedback } = data;
  const calls: ModelCall[] = isModelCallArray(event.model_calls) ? event.model_calls : [];
  const candidates: AltRow[] = isAlternativeArray(event.alternatives) ? event.alternatives : [];
  const callByStage = (s: string) => calls.find((c) => c.stage === s);

  // Compose the rendered timeline. Adapters return null for stages
  // that didn't run; we filter those out. Total = number of rendered
  // blocks + 1 (the terminal Result is in the spine but doesn't get
  // its own block; the index/total counters reflect block-only
  // numbering so "Stage 4 / 5" reads naturally).
  const ctxBase = {
    event,
    candidates,
    t: t as T,
  };
  // Two-pass render so each stage knows the NEXT stage's id + label
  // for the handoff pill. First pass: build adapters with placeholder
  // index/next info; second pass: walk the array and rewrite.
  const order: Array<(c: StageAdapterCtx) => StageRender | null> = [
    adaptCleanup, adaptRetrieval, adaptResearch, adaptGate, adaptPicker, adaptBestEffort,
  ];

  // Pre-resolve which stages will render so we can pass next-stage
  // info into each adapter's ctx.
  const dryRun: Array<{ adapter: typeof order[number]; call?: ModelCall }> = [
    { adapter: adaptCleanup,    call: callByStage('cleanup') },
    { adapter: adaptRetrieval,  call: undefined }, // always renders
    { adapter: adaptResearch,   call: callByStage('research') },
    { adapter: adaptGate,       call: undefined }, // always renders
    { adapter: adaptPicker,     call: callByStage('picker') },
    { adapter: adaptBestEffort, call: callByStage('best_effort') },
  ];
  // Filter the ones whose adapters would return null (optional stages
  // without a model_call). Retrieval and gate always render.
  const willRender = dryRun.filter((s, i) => {
    if (i === 1 || i === 3) return true; // retrieval, gate
    return !!s.call;
  });
  const totalBlocks = willRender.length;

  // Build the actual StageRender list with correct index + next info.
  const stageTitleByAdapter = (a: typeof order[number]): string => {
    if (a === adaptCleanup) return t('t2_cleanup_title');
    if (a === adaptRetrieval) return t('t2_retrieval_title');
    if (a === adaptResearch) return t('t2_research_title');
    if (a === adaptGate) return t('t2_gate_title');
    if (a === adaptPicker) return t('t2_picker_title');
    return t('t2_best_effort_title');
  };

  const renders: StageRender[] = willRender.map((s, i) => {
    const next = willRender[i + 1];
    const ctx: StageAdapterCtx = {
      ...ctxBase,
      call: s.call,
      index: i + 1,
      total: totalBlocks,
      nextHref: next ? `#${idForAdapter(next.adapter)}` : undefined,
      nextLabel: next ? stageTitleByAdapter(next.adapter) : undefined,
    };
    return s.adapter(ctx)!;
  });

  // Spine pills = rendered blocks + a terminal Result pill.
  const spinePills: SpinePillSpec[] = [
    ...renders.map((r) => ({ ...r.spine, href: `#${r.id}` })),
    {
      href: '#result',
      label: 'Result',
      meta: event.chosen_code ?? '—',
      state: event.chosen_code ? ('good' as const) : ('bad' as const),
    },
  ];

  const handleFeedbackSubmit = async (
    kind: FeedbackKind,
    body: { reason?: string; corrected_code?: string; rejected_code?: string },
  ) => {
    await api.feedback(event.id, { kind, ...body });
    await refresh();
  };

  return (
    <main className="max-w-[920px] mx-auto px-7 pt-12 pb-16 flex flex-col gap-6">
      <a href="/" className="inline-flex items-center gap-1 text-[13px] text-[var(--ink-3)] hover:text-[var(--ink)] no-underline w-fit">
        <span aria-hidden>←</span><span>{t('trace_back')}</span>
      </a>

      {/* ── Header band ── */}
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase">{t('trace_endpoint')}</span>
              <span className="font-mono text-[14px] text-[var(--ink)] capitalize">{event.endpoint}</span>
              <span className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase ms-3">{t('trace_total_latency')}</span>
              <span className="font-mono text-[14px] text-[var(--ink)]">{fmtMs(event.total_latency_ms)}</span>
            </div>
            <div className="font-mono text-[11px] text-[var(--ink-3)]">{fmtDate(event.created_at)}</div>
            <div className="font-mono text-[11px] text-[var(--ink-3)]">
              {t('trace_request_id')}: <span className="text-[var(--ink-2)]">{event.id}</span>
            </div>
          </div>
        </div>
        {requestText(event) && (
          <div className="px-4 py-3 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--line-2)]">
            <div className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-1">{t('trace_input')}</div>
            <div className="text-[14px] text-[var(--ink)] leading-[1.5] break-words">{requestText(event)}</div>
          </div>
        )}
      </header>

      {/* ── Spine ── */}
      <TraceSpine pills={spinePills} />

      {/* ── Stage blocks ── */}
      <div className="flex flex-col gap-4">
        {renders.map((r) => r.node)}
      </div>

      {/*
        ── Required procedures ──
        Renders ONLY when the trace event carries the procedures array
        on `event.result.procedures`. The /trace/:id endpoint does not
        currently expose this — it only logs the chosen `code`, not the
        joined catalog row. When the backend adds it (likely via a join
        in the trace query against the catalog's procedure-codes table),
        the cast below picks it up automatically without a frontend
        change. Until then, this block is a no-op on every trace.

        Trace mode shows repealed entries inline (no disclosure) so
        operators get full audit fidelity at decision time.
      */}
      {(() => {
        const procs = (event as { result?: { procedures?: import('@/lib/api').ProcedureRef[] } })
          .result?.procedures;
        if (!procs || procs.length === 0) return null;
        return (
          <section className="mt-2">
            <RequiredProcedures procedures={procs} mode="trace" />
          </section>
        );
      })()}

      {/* ── Terminal result anchor (target of the last spine pill) ── */}
      <section
        id="result"
        className={cn(
          'rounded-[var(--radius)] border px-4 py-3 text-[14px]',
          event.chosen_code
            ? 'border-[color-mix(in_oklab,oklch(0.55_0.15_155)_35%,var(--line))] bg-[color-mix(in_oklab,oklch(0.95_0.05_155)_50%,var(--surface))] text-[oklch(0.42_0.12_155)]'
            : 'border-[color-mix(in_oklab,oklch(0.55_0.18_25)_35%,var(--line))] bg-[color-mix(in_oklab,oklch(0.94_0.05_25)_50%,var(--surface))] text-[oklch(0.42_0.14_25)]',
        )}
      >
        <strong className="font-medium">
          {event.chosen_code
            ? t('t2_terminal_ok').replace('{code}', event.chosen_code)
            : t('t2_terminal_no_code')}
        </strong>
      </section>

      {/* ── Feedback ── */}
      <section>
        <FeedbackBlock
          feedback={feedback}
          chosenCode={event.chosen_code}
          alternatives={candidates}
          onSubmit={handleFeedbackSubmit}
        />
      </section>

      {/* ── Raw JSON ── */}
      <details className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)]">
        <summary className="cursor-pointer px-4 py-2.5 font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase select-none">
          {t('trace_raw_json')}
        </summary>
        <RawJsonBlock data={data} copyLabel={t('trace_copy_json')} copiedLabel={t('copied')} />
      </details>
    </main>
  );
}

// Helper used by the two-pass adapter wiring above.
function idForAdapter(a: (c: StageAdapterCtx) => StageRender | null): string {
  if (a === adaptCleanup)    return 'stage-cleanup';
  if (a === adaptRetrieval)  return 'stage-retrieval';
  if (a === adaptResearch)   return 'stage-research';
  if (a === adaptGate)       return 'stage-gate';
  if (a === adaptPicker)     return 'stage-picker';
  return 'stage-best-effort';
}
