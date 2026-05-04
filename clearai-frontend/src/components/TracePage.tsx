/**
 * Trace page: operator audit + feedback for one classification.
 *
 * Rewritten in the May-3 trace iteration to match the actual current
 * pipeline. The pre-iteration version hardcoded a 3-stage flow and a
 * 3-arm parallel-retrieval narrative that no longer exists. This
 * version reads `event.model_calls[]` AND the `event.request.*`
 * breadcrumbs and renders one card per stage that ACTUALLY ran. The
 * "STAGE X / N" counter is gone — the timeline shape itself
 * communicates progression.
 *
 * Stages, in canonical order:
 *   1. cleanup           (cleanup_invoked is set)
 *   2. researcher        (research_kind set OR model_call stage='research')
 *   3. researcher_web    (research_web_kind set OR stage='research_web')
 *   4. retrieval         (candidate_count > 0)
 *   5. evidence_gate     (always renders if retrieval ran)
 *   6. picker            (model_call stage='picker' present)
 *   7. branch_rank       (stage='branch_rank' OR branch_rank_invoked='llm')
 *   8. best_effort       (stage='best_effort' OR best_effort_invoked=true)
 *
 * Gate threshold defaults are hardcoded from setup_meta (they rarely
 * change — see `GATE_DEFAULTS`). When `event.thresholds` is present
 * the recorded values win; otherwise we fall back to the defaults so
 * the trace UI never says "(threshold not recorded)".
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  api,
  ApiError,
  type TraceResponse,
  type TraceEvent,
  type TraceFeedback,
  type TraceRequestMeta,
  type FeedbackKind,
} from '@/lib/api';
import {
  StageBlock,
  StageSection,
  StageDecision,
  StageRaw,
  StageChecks,
  type CheckState,
} from './trace/StageBlock';
import {
  RetrievalFunnel,
  type AltRow,
} from './trace/RetrievalFunnel';
import RequiredProcedures from './RequiredProcedures';

// ── Types & guards ─────────────────────────────────────────────────────

interface ModelCall {
  /** Backend stage tag — see ModelCall stage enum in the spec. */
  stage:
    | 'cleanup'
    | 'research'
    | 'research_web'
    | 'picker'
    | 'branch_rank'
    | 'best_effort'
    | string;
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

// ── Constants ──────────────────────────────────────────────────────────

/**
 * Gate thresholds loaded by the backend from `setup_meta` at request
 * time. They're rarely changed and the trace endpoint doesn't always
 * echo them, so we keep a frontend fallback. When `event.thresholds`
 * is recorded, those values win.
 */
const GATE_DEFAULTS = {
  /** Top score must be ≥ this for the gate to pass. */
  min_score: 0.30,
  /** Gap between #1 and #2 must be ≥ this; smaller values get flagged. */
  min_gap: 0.04,
  /** Candidate count must be ≥ this; rarely fails. */
  min_candidates: 1,
  /** Distinct chapters in the top-K must be ≤ this. */
  max_distinct_chapters: 3,
} as const;

// ── Formatters ─────────────────────────────────────────────────────────

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
/** Short trace id, e.g. `019dea91…` for headers. */
function shortId(uuid: string): string {
  return uuid.length > 8 ? `${uuid.slice(0, 8)}…` : uuid;
}
function resolveEventId(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('id') ?? '';
}

// ── Adapter context ────────────────────────────────────────────────────

interface StageRender {
  /** Anchor id for in-page links. */
  id: string;
  /** Stage block JSX. */
  node: React.ReactElement;
}

type T = (key: TKey) => string;
type StageAdapterCtx = {
  event: TraceEvent;
  /** Parsed `event.request` cast to the breadcrumbs struct. */
  reqMeta: TraceRequestMeta;
  /** This stage's matching model_call entry (if any). */
  call?: ModelCall;
  candidates: AltRow[];
  /** Render a "skipped (gate refused)" placeholder for the picker. */
  forceRenderSkipped?: boolean;
  t: T;
};

// ── Adapters (one per stage) ───────────────────────────────────────────

function adaptCleanup(ctx: StageAdapterCtx): StageRender | null {
  const { event, reqMeta, call, t } = ctx;
  // Cleanup renders if the breadcrumb is present (it's set on every
  // request after the cleanup-rollout). Older rows without the
  // breadcrumb fall through.
  if (reqMeta.cleanup_invoked == null && !call) return null;

  const status = call?.status ?? 'ok';
  const block: 'good' | 'warn' | 'bad' =
    reqMeta.cleanup_invoked === 'llm_failed' || reqMeta.cleanup_invoked === 'llm_unparseable' || status !== 'ok'
      ? 'warn'
      : 'good';

  // Map backend invoked-tag to the human sentence describing what cleanup did.
  const invokedKey = ((): TKey => {
    switch (reqMeta.cleanup_invoked) {
      case 'skipped_clean':    return 't2_cleanup_invoked_skipped_clean';
      case 'llm':              return 't2_cleanup_invoked_llm';
      case 'llm_failed':       return 't2_cleanup_invoked_llm_failed';
      case 'llm_unparseable':  return 't2_cleanup_invoked_llm_unparseable';
      default:                 return 't2_cleanup_what';
    }
  })();

  // Noun-grounded line picks one of three texts — keeps the cleanup
  // outcome readable ("✓ proceeded" / "✗ escalated to researcher" / "—").
  const groundedKey: TKey =
    event.cleanup_noun_grounded === true  ? 't2_cleanup_grounded_yes' :
    event.cleanup_noun_grounded === false ? 't2_cleanup_grounded_no'  :
                                            't2_cleanup_grounded_unknown';

  return {
    id: 'stage-cleanup',
    node: (
      <StageBlock
        key="cleanup"
        id="stage-cleanup"
        title={t('t2_cleanup_title')}
        state={block}
        stateLabel={t(status === 'ok' ? 't2_state_ok' : 't2_state_failed')}
        meta={call ? fmtMs(call.latency_ms) : reqMeta.cleanup_latency_ms != null ? fmtMs(reqMeta.cleanup_latency_ms) : undefined}
        model={call?.model}
      >
        <StageSection
          label={t('t2_section_what_does')}
          labelExtra={call ? <ModelChip model={call.model} /> : null}
        >
          {t(invokedKey)}
        </StageSection>

        <StageSection label={t('t2_cleanup_kind_label')}>
          <code className="font-mono text-[13px] text-[var(--ink)]">
            {reqMeta.cleanup_kind ?? '—'}
          </code>
        </StageSection>

        {reqMeta.cleanup_effective && (
          <StageSection label={t('t2_cleanup_cleaned_label')}>
            <span className="text-[var(--ink)]">"{reqMeta.cleanup_effective}"</span>
          </StageSection>
        )}

        <StageSection label={t('t2_cleanup_stripped_label')}>
          <span className="font-mono text-[13px] text-[var(--ink-2)] tabular-nums">
            {reqMeta.cleanup_stripped_count ?? 0}
          </span>
        </StageSection>

        <StageSection label={t('t2_cleanup_attrs_label')}>
          <span className="font-mono text-[13px] text-[var(--ink-2)] tabular-nums">
            {reqMeta.cleanup_attributes_count ?? 0}
          </span>
        </StageSection>

        <StageSection label={t('t2_cleanup_grounded_label')}>
          <span className="text-[var(--ink-2)]">{t(groundedKey)}</span>
        </StageSection>

        <StageRaw
          data={{ call, breadcrumb: {
            cleanup_invoked: reqMeta.cleanup_invoked,
            cleanup_kind: reqMeta.cleanup_kind,
            cleanup_effective: reqMeta.cleanup_effective,
            cleanup_attributes_count: reqMeta.cleanup_attributes_count,
            cleanup_stripped_count: reqMeta.cleanup_stripped_count,
            cleanup_latency_ms: reqMeta.cleanup_latency_ms,
            cleanup_noun_grounded: event.cleanup_noun_grounded,
          } }}
          showLabel={t('t2_show_raw')}
          hideLabel={t('t2_hide_raw')}
        />
      </StageBlock>
    ),
  };
}

function adaptResearch(ctx: StageAdapterCtx): StageRender | null {
  const { reqMeta, call, t } = ctx;
  if (!call && !reqMeta.research_kind) return null;

  const kindKey: TKey =
    reqMeta.research_kind === 'recognised' ? 't2_research_kind_recognised' :
    reqMeta.research_kind === 'unknown'    ? 't2_research_kind_unknown'    :
    reqMeta.research_kind === 'failed'     ? 't2_research_kind_failed'     :
                                             't2_research_kind_unknown';

  const status = call?.status ?? 'ok';
  const block: 'good' | 'warn' | 'bad' =
    reqMeta.research_kind === 'failed' || status !== 'ok' ? 'warn' :
    reqMeta.research_kind === 'unknown' ? 'warn' : 'good';

  return {
    id: 'stage-research',
    node: (
      <StageBlock
        key="research"
        id="stage-research"
        title={t('t2_research_title')}
        state={block}
        stateLabel={t(status === 'ok' ? 't2_state_ok' : 't2_state_failed')}
        meta={call ? fmtMs(call.latency_ms) : reqMeta.research_latency_ms != null ? fmtMs(reqMeta.research_latency_ms) : undefined}
        model={call?.model}
      >
        <StageSection
          label={t('t2_section_what_does')}
          labelExtra={call ? <ModelChip model={call.model} /> : null}
        >
          {t('t2_research_what')}
        </StageSection>

        <StageSection label={t('t2_research_kind_label')}>
          <span className="text-[var(--ink-2)]">{t(kindKey)}</span>
        </StageSection>

        {reqMeta.rewritten_as && (
          <StageSection label={t('t2_research_rewritten_label')}>
            <span className="text-[var(--ink)]">"{reqMeta.rewritten_as}"</span>
          </StageSection>
        )}

        <StageRaw
          data={{ call, breadcrumb: {
            research_kind: reqMeta.research_kind,
            rewritten_as: reqMeta.rewritten_as,
            research_latency_ms: reqMeta.research_latency_ms,
          } }}
          showLabel={t('t2_show_raw')}
          hideLabel={t('t2_hide_raw')}
        />
      </StageBlock>
    ),
  };
}

function adaptResearchWeb(ctx: StageAdapterCtx): StageRender | null {
  const { reqMeta, call, t } = ctx;
  if (!call && !reqMeta.research_web_kind) return null;

  const status = call?.status ?? 'ok';
  return {
    id: 'stage-research-web',
    node: (
      <StageBlock
        key="research_web"
        id="stage-research-web"
        title={t('t2_research_web_title')}
        state={status === 'ok' ? 'good' : 'warn'}
        stateLabel={t(status === 'ok' ? 't2_state_ok' : 't2_state_failed')}
        meta={call ? fmtMs(call.latency_ms) : reqMeta.research_web_latency_ms != null ? fmtMs(reqMeta.research_web_latency_ms) : undefined}
        model={call?.model}
      >
        <StageSection
          label={t('t2_section_what_does')}
          labelExtra={call ? <ModelChip model={call.model} /> : null}
        >
          {t('t2_research_web_what')}
        </StageSection>

        <StageRaw
          data={{ call, breadcrumb: {
            research_web_kind: reqMeta.research_web_kind,
            research_web_latency_ms: reqMeta.research_web_latency_ms,
          } }}
          showLabel={t('t2_show_raw')}
          hideLabel={t('t2_hide_raw')}
        />
      </StageBlock>
    ),
  };
}

function adaptRetrieval(ctx: StageAdapterCtx): StageRender | null {
  const { event, t, candidates } = ctx;
  const top = event.top_retrieval_score;
  const gap = event.top2_gap;
  const count = event.candidate_count;
  if (count == null || count <= 0) return null;

  return {
    id: 'stage-retrieval',
    node: (
      <StageBlock
        key="retrieval"
        id="stage-retrieval"
        title={t('t2_retrieval_title')}
        titleGloss={t('t2_glossary_rrf')}
        state="good"
        stateLabel={`${count}`}
        meta={count != null ? `${count} candidates` : undefined}
      >
        <StageSection label={t('t2_section_what_does')}>
          {t('t2_retrieval_what')}
        </StageSection>

        <StageSection label={t('t2_retrieval_query_label')}>
          <strong className="text-[var(--ink)]">{requestText(event)}</strong>
        </StageSection>

        <StageSection label={t('t2_retrieval_stages_label')}>
          <RetrievalFunnel
            candidates={candidates}
            finalCount={count ?? candidates.length}
            stage1Count={event.retrieval_stage1_count ?? null}
            top2Gap={gap}
            top2GapMin={GATE_DEFAULTS.min_gap}
          />
        </StageSection>

        <StageRaw
          data={{
            embedder_version: event.embedder_version,
            candidate_count: count,
            retrieval_stage1_count: event.retrieval_stage1_count,
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

function adaptGate(ctx: StageAdapterCtx): StageRender | null {
  const { event, reqMeta, t } = ctx;
  if (event.candidate_count == null || event.candidate_count <= 0) return null;

  const top = event.top_retrieval_score;
  const gap = event.top2_gap;
  const count = event.candidate_count;
  const distinctChapters = reqMeta.understanding_distinct_chapters ?? null;

  // Hardcoded defaults take over when the event row didn't echo
  // setup_meta — replaces the old "(threshold not recorded)" path.
  const minScore = event.thresholds?.gate_min_score ?? GATE_DEFAULTS.min_score;
  const minGap   = event.thresholds?.gate_min_gap   ?? GATE_DEFAULTS.min_gap;
  const minCount = event.thresholds?.gate_min_candidates ?? GATE_DEFAULTS.min_candidates;
  const maxDistinct = GATE_DEFAULTS.max_distinct_chapters;

  const topState: CheckState   = top   == null ? 'unknown' : top   >= minScore ? 'pass' : 'fail';
  const gapState: CheckState   = gap   == null ? 'unknown' : gap   >= minGap   ? 'pass' : 'warn';
  const countState: CheckState = count == null ? 'unknown' : count >= minCount ? 'pass' : 'fail';
  const distinctState: CheckState =
    distinctChapters == null ? 'unknown' :
    distinctChapters <= maxDistinct ? 'pass' : 'warn';

  // Decision = derived from event.decision_reason (gate failed when
  // the picker was bypassed in favour of best-effort or weak_retrieval).
  const gateFailed =
    event.decision_reason === 'weak_retrieval'
    || event.decision_reason === 'invalid_prefix'
    || event.decision_reason === 'ambiguous_top_candidates';

  const flagged = gapState === 'warn' && !gateFailed;

  const blockState: 'good' | 'warn' | 'bad' = gateFailed ? 'bad' : flagged ? 'warn' : 'good';

  return {
    id: 'stage-gate',
    node: (
      <StageBlock
        key="gate"
        id="stage-gate"
        title={t('t2_gate_title')}
        titleGloss={t('t2_glossary_gate')}
        state={blockState}
        stateLabel={t(gateFailed ? 't2_state_refused' : flagged ? 't2_state_warned' : 't2_state_ok')}
      >
        <StageSection label={t('t2_section_what_does')}>
          {t('t2_gate_what')}
        </StageSection>

        <StageSection label={t('t2_gate_thresholds_label')}>
          <StageChecks
            rows={[
              {
                state: topState,
                label: t('t2_gate_top_label').replace('{score}', fmtScore(top)),
                rule: t('t2_gate_top_rule').replace('{min}', String(minScore)),
              },
              {
                state: gapState,
                label: t('t2_gate_gap_label').replace('{gap}', fmtScore(gap)),
                rule: t('t2_gate_gap_rule').replace('{min}', String(minGap)),
              },
              {
                state: countState,
                label: t('t2_gate_count_label').replace('{n}', String(count ?? '—')),
                rule: t('t2_gate_count_rule').replace('{min}', String(minCount)),
              },
              ...(distinctChapters != null ? [{
                state: distinctState,
                label: `Distinct chapters in top-5: ${distinctChapters}`,
                rule: `≤ ${maxDistinct}`,
              }] : []),
            ]}
          />
        </StageSection>

        <StageSection label={t('t2_section_decision')}>
          {gateFailed ? (
            <StageDecision tone="bad" title={t('t2_gate_decision_fail_title')}>
              {t('t2_gate_decision_fail_body')}
            </StageDecision>
          ) : flagged ? (
            <StageDecision tone="warn" title={t('t2_gate_decision_warn_title')}>
              {t('t2_gate_decision_warn_body')}
            </StageDecision>
          ) : (
            <StageDecision tone="good" title={t('t2_gate_decision_pass_title')}>
              {t('t2_gate_decision_pass_body')}
            </StageDecision>
          )}
        </StageSection>

        <StageRaw
          data={{
            thresholds: {
              gate_min_score: minScore,
              gate_min_gap: minGap,
              gate_min_candidates: minCount,
              max_distinct_chapters: maxDistinct,
              recorded: event.thresholds ?? null,
              defaulted: event.thresholds == null,
            },
            observed: { top_score: top, top2_gap: gap, candidate_count: count, distinct_chapters: distinctChapters },
            evaluated: { top: topState, gap: gapState, count: countState, distinct: distinctState },
          }}
          showLabel={t('t2_show_raw')}
          hideLabel={t('t2_hide_raw')}
        />
      </StageBlock>
    ),
  };
}

function adaptPicker(ctx: StageAdapterCtx): StageRender | null {
  const { event, call, t, forceRenderSkipped } = ctx;

  if (!call && forceRenderSkipped) {
    return {
      id: 'stage-picker',
      node: (
        <StageBlock
          key="picker"
          id="stage-picker"
          title={t('t2_picker_title')}
          titleGloss={t('t2_glossary_picker')}
          state="skipped"
          stateLabel={t('t2_state_skipped')}
        >
          <StageSection label={t('t2_section_what_does')}>
            {t('t2_picker_what')}
          </StageSection>
          <StageSection label={t('t2_section_decision')}>
            <StageDecision tone="warn" title={t('t2_picker_decision_skipped_title')}>
              {t('t2_picker_decision_skipped_body')}
            </StageDecision>
          </StageSection>
        </StageBlock>
      ),
    };
  }

  if (!call) return null;
  const guarded = event.guard_tripped;
  const chosen = event.chosen_code;
  const blockState: 'good' | 'warn' | 'bad' =
    guarded ? 'bad' : chosen ? 'good' : 'warn';

  return {
    id: 'stage-picker',
    node: (
      <StageBlock
        key="picker"
        id="stage-picker"
        title={t('t2_picker_title')}
        titleGloss={t('t2_glossary_picker')}
        state={blockState}
        stateLabel={
          guarded ? t('t2_state_failed')
            : chosen ? t('t2_state_ok')
              : t('t2_state_skipped')
        }
        meta={fmtMs(call.latency_ms)}
        model={call.model}
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
            <blockquote className="border border-[var(--line)] bg-[var(--accent-soft)] px-3.5 py-2 m-0 rounded-[var(--radius)] text-[13.5px] leading-[1.6] text-[var(--ink-2)]">
              {event.rationale}
            </blockquote>
          </StageSection>
        )}

        <StageSection label={t('t2_picker_checks_label')}>
          <StageChecks
            rows={[
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
            ]}
          />
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

        <StageRaw data={call} showLabel={t('t2_show_raw')} hideLabel={t('t2_hide_raw')} />
      </StageBlock>
    ),
  };
}

function adaptBranchRank(ctx: StageAdapterCtx): StageRender | null {
  const { reqMeta, call, t } = ctx;
  if (!call && reqMeta.branch_rank_invoked !== 'llm') return null;

  const status = call?.status ?? 'ok';
  const overrode = reqMeta.branch_rank_overrode === true;

  return {
    id: 'stage-branch-rank',
    node: (
      <StageBlock
        key="branch_rank"
        id="stage-branch-rank"
        title={t('t2_branch_rank_title')}
        state={status === 'ok' ? 'good' : 'warn'}
        stateLabel={t(status === 'ok' ? 't2_state_ok' : 't2_state_failed')}
        meta={call ? fmtMs(call.latency_ms) : reqMeta.branch_rank_latency_ms != null ? fmtMs(reqMeta.branch_rank_latency_ms) : undefined}
        model={call?.model}
      >
        <StageSection
          label={t('t2_section_what_does')}
          labelExtra={call ? <ModelChip model={call.model} /> : null}
        >
          {t('t2_branch_rank_what')}
        </StageSection>

        {reqMeta.branch_rank_picker_choice && (
          <StageSection label={t('t2_branch_rank_picker_label')}>
            <code className="font-mono text-[13.5px] text-[var(--ink-2)]">{reqMeta.branch_rank_picker_choice}</code>
          </StageSection>
        )}

        {reqMeta.branch_rank_top_pick && (
          <StageSection label={t('t2_branch_rank_final_label')}>
            <code className={cn(
              'font-mono text-[13.5px]',
              overrode ? 'text-[oklch(0.42_0.13_60)] font-medium' : 'text-[var(--ink)]',
            )}>
              {reqMeta.branch_rank_top_pick}
            </code>{' '}
            <span className="text-[12.5px] text-[var(--ink-3)]">
              {overrode ? t('t2_branch_rank_overrode') : t('t2_branch_rank_agreed')}
            </span>
          </StageSection>
        )}

        <StageRaw
          data={{ call, breadcrumb: {
            branch_rank_invoked: reqMeta.branch_rank_invoked,
            branch_rank_picker_choice: reqMeta.branch_rank_picker_choice,
            branch_rank_top_pick: reqMeta.branch_rank_top_pick,
            branch_rank_overrode: reqMeta.branch_rank_overrode,
            branch_rank_latency_ms: reqMeta.branch_rank_latency_ms,
          } }}
          showLabel={t('t2_show_raw')}
          hideLabel={t('t2_hide_raw')}
        />
      </StageBlock>
    ),
  };
}

function adaptBestEffort(ctx: StageAdapterCtx): StageRender | null {
  const { event, reqMeta, call, t } = ctx;
  if (!call && reqMeta.best_effort_invoked !== true) return null;

  return {
    id: 'stage-best-effort',
    node: (
      <StageBlock
        key="best_effort"
        id="stage-best-effort"
        title={t('t2_best_effort_title')}
        titleGloss={t('t2_glossary_best_effort')}
        state="warn"
        stateLabel={t('t2_state_ok')}
        meta={call ? fmtMs(call.latency_ms) : undefined}
        model={call?.model}
      >
        <StageSection
          label={t('t2_section_what_does')}
          labelExtra={call ? <ModelChip model={call.model} /> : null}
        >
          {t('t2_best_effort_what')}
        </StageSection>

        {reqMeta.best_effort_specificity != null && (
          <StageSection label={t('t2_best_effort_specificity_label')}>
            <span className="font-mono text-[13.5px] text-[var(--ink-2)] tabular-nums">
              {t('t2_best_effort_specificity_value').replace('{n}', String(reqMeta.best_effort_specificity))}
            </span>
          </StageSection>
        )}

        {event.chosen_code && (
          <StageSection label={t('t2_best_effort_outcome_label')}>
            <StageDecision tone="warn" title={t('t2_state_ok')}>
              {t('t2_best_effort_outcome_body')
                .replace('{code}', event.chosen_code)
                .replace('{reason}', event.decision_reason)}
            </StageDecision>
          </StageSection>
        )}

        {/* Rationale renders here when best-effort owns it (picker didn't run). */}
        {event.rationale && (
          <StageSection label={t('t2_picker_why_label')}>
            <blockquote className="border border-[var(--line)] bg-[var(--accent-soft)] px-3.5 py-2 m-0 rounded-[var(--radius)] text-[13.5px] leading-[1.6] text-[var(--ink-2)]">
              {event.rationale}
            </blockquote>
          </StageSection>
        )}

        <StageRaw
          data={{ call, breadcrumb: {
            best_effort_invoked: reqMeta.best_effort_invoked,
            best_effort_specificity: reqMeta.best_effort_specificity,
          } }}
          showLabel={t('t2_show_raw')}
          hideLabel={t('t2_hide_raw')}
        />
      </StageBlock>
    ),
  };
}

// ── Small reusables ────────────────────────────────────────────────────

function ModelChip({ model }: { model: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--line-2)] border border-[var(--line)] font-mono text-[10.5px] text-[var(--ink-3)]">
      {model}
    </span>
  );
}

// `LLMBadge` and `familyOf` retired in the trace mockup-match
// rebuild. The new StageBlock header carries the model name as a
// quiet inline pill (`model={call.model}`) so a separate LLM badge
// would just duplicate it.

function requestText(e: TraceEvent): string {
  if (typeof e.request === 'object' && e.request !== null && 'description' in e.request) {
    return String((e.request as { description?: unknown }).description ?? '');
  }
  return '';
}

// ── Feedback panel ─────────────────────────────────────────────────────

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

  // Per the May-3 spec: show the "Was this classification correct?"
  // panel ONLY when feedback is empty. When feedback already exists
  // we render the recorded decision instead.
  if (feedback.length > 0) {
    return (
      <div className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] p-4 flex flex-col gap-3">
        <div className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase">{t('fb_history_title')}</div>
        <ul className="text-[12.5px] text-[var(--ink-2)] flex flex-col gap-1 m-0 ps-0 list-none">
          {feedback.map((f) => (
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
      </div>
    );
  }

  return (
    <div className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] p-4 flex flex-col gap-3">
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
  );
}

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

// ── Top-level page ─────────────────────────────────────────────────────

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
  const reqMeta: TraceRequestMeta =
    typeof event.request === 'object' && event.request !== null
      ? (event.request as TraceRequestMeta)
      : {};
  const candidates: AltRow[] = isAlternativeArray(event.alternatives) ? event.alternatives : [];

  // Lookup helpers — match canonical and legacy stage names.
  const callFor = (...names: string[]): ModelCall | undefined =>
    calls.find((c) => names.includes(c.stage));
  const pickerCall = callFor('picker');
  const bestEffortCall = callFor('best_effort');

  // Force-render the picker as "skipped" when best-effort owns the
  // result (gate refused → picker bypassed → best-effort fired).
  const pickerShouldRenderSkipped =
    !pickerCall && (event.decision_status === 'best_effort' || !!bestEffortCall);

  // Build the timeline. ORDER matters — this is the canonical pipeline
  // order. Adapters return `null` when their stage didn't run.
  const ctxBase = { event, reqMeta, candidates, t: t as T };
  const stageRenders: StageRender[] = [
    adaptCleanup({       ...ctxBase, call: callFor('cleanup') }),
    adaptResearch({      ...ctxBase, call: callFor('research', 'researcher') }),
    adaptResearchWeb({   ...ctxBase, call: callFor('research_web', 'researcher_web') }),
    adaptRetrieval(      ctxBase ),
    adaptGate(           ctxBase ),
    adaptPicker({        ...ctxBase, call: pickerCall, forceRenderSkipped: pickerShouldRenderSkipped }),
    adaptBranchRank({    ...ctxBase, call: callFor('branch_rank') }),
    adaptBestEffort({    ...ctxBase, call: bestEffortCall }),
  ].filter((s): s is StageRender => s !== null);

  const handleFeedbackSubmit = async (
    kind: FeedbackKind,
    body: { reason?: string; corrected_code?: string; rejected_code?: string },
  ) => {
    await api.feedback(event.id, { kind, ...body });
    await refresh();
  };

  const needsReview = event.needs_review === true;

  // Build a small per-stage summary for the pipeline strip at the
  // top of the page (mockup: 5 underline-tab cells, each `01 / Title
  // / 0.42s`). We pull title + meta straight from the rendered
  // StageBlock props via cloneElement after the fact.
  const pipelineStripCells = stageRenders.map((r, i) => {
    const props = (r.node as React.ReactElement<{ title: string; meta?: string }>).props;
    return {
      id: r.id,
      n: String(i + 1).padStart(2, '0'),
      title: props.title,
      meta: props.meta ?? '',
    };
  });

  return (
    // Mockup-match: 1080px max, 28px gutters. Sticky topbar + page
    // header + input row + pipeline strip + stage cards + bottom row.
    <main className="max-w-[1080px] mx-auto px-7 pt-10 pb-20 flex flex-col gap-7">

      {/* Page header — `Trace` h1 + sub line + Input row. */}
      <header className="flex flex-col gap-3">
        <h1 className="m-0 text-[24px] font-semibold tracking-[-0.015em] text-[var(--ink)]">
          {t('trace_page_title')}
        </h1>
        <p className="m-0 text-[14px] text-[var(--ink-2)]">
          {t('trace_page_sub')
            .replace('{n}', String(stageRenders.length))
            .replace('{latency}', fmtMs(event.total_latency_ms))
            .replace('{id}', shortId(event.id))}
          {needsReview && (
            <span
              className="ms-3 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium uppercase tracking-[0.06em] align-middle"
              style={{ background: 'oklch(0.95 0.06 75)', color: 'oklch(0.42 0.13 60)' }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'oklch(0.62 0.16 60)' }} />
              {t('trace_needs_review_badge')}
            </span>
          )}
        </p>

        {/* Input row — grey card with mono uppercase label + value. */}
        {requestText(event) && (
          <div className="mt-3 px-[18px] py-3.5 rounded-[var(--radius)] bg-[var(--line-2)]">
            <div className="font-mono text-[10.5px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-1">
              {t('trace_input')}
            </div>
            <div className="text-[14px] text-[var(--ink)] leading-[1.5] break-words">
              {requestText(event)}
            </div>
          </div>
        )}
      </header>

      {/*
        Pipeline strip: 5-column underline-tab feel. Each cell is a
        permanent `01 / Title / 0.42s`. Active = bottom-border ink.
        On the trace page everything that ran has already run, so all
        cells are "active" (mockup behaviour).
      */}
      {pipelineStripCells.length > 0 && (
        <nav
          aria-label="Pipeline stages overview"
          className="flex items-stretch gap-0 overflow-x-auto -mx-2"
        >
          {pipelineStripCells.map((c) => (
            <a
              key={c.id}
              href={`#${c.id}`}
              className="flex-1 min-w-[112px] py-3 px-3.5 border-b-2 border-[var(--ink)] no-underline transition-colors duration-150 hover:bg-[var(--line-2)]"
            >
              <div className="font-mono text-[10px] text-[var(--ink-3)] tracking-[0.08em] uppercase mb-1">
                {c.n}
              </div>
              <div className="text-[13.5px] text-[var(--ink)] font-medium leading-tight whitespace-nowrap overflow-hidden text-ellipsis">
                {c.title}
              </div>
              {c.meta && (
                <div className="font-mono text-[10.5px] text-[var(--ink-3)] mt-0.5">
                  {c.meta}
                </div>
              )}
            </a>
          ))}
        </nav>
      )}

      {/* Stages — collapsible cards, the first one open by default. */}
      <div className="flex flex-col gap-2.5">
        {stageRenders.map((r, i) =>
          // Inject the 1-based index + defaultOpen on the first card
          // so the page surfaces the cleanup outcome on load.
          React.cloneElement(r.node, { index: i + 1, defaultOpen: i === 0 } as Partial<{ index: number; defaultOpen: boolean }>),
        )}
      </div>

      {/* Required procedures — renders only when event.result.procedures is present. */}
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

      {/* Feedback panel (only renders when feedback is empty per spec). */}
      <section>
        <FeedbackBlock
          feedback={feedback}
          chosenCode={event.chosen_code}
          alternatives={candidates}
          onSubmit={handleFeedbackSubmit}
        />
      </section>

      {/* Raw JSON expander — power-user escape hatch. */}
      <details className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)]">
        <summary className="cursor-pointer px-4 py-2.5 font-mono text-[11px] text-[var(--ink-3)] tracking-[0.06em] uppercase select-none">
          {t('trace_raw_json')}
        </summary>
        <RawJsonBlock data={data} copyLabel={t('trace_copy_json')} copiedLabel={t('copied')} />
      </details>

      {/*
        Bottom row — final code on the start side, action buttons on
        the end side. Matches the trace mockup's footer.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-6 border-t border-[var(--line)]">
        <div id="result" className="text-[13px] text-[var(--ink-3)]">
          {event.chosen_code ? (
            <>
              <span>{t('trace_final_code')} · </span>
              <span className="font-mono text-[var(--ink-2)]">{event.chosen_code}</span>
            </>
          ) : (
            <span>{t('t2_terminal_no_code')}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-[var(--line)] bg-[var(--surface)] text-[13px] font-medium text-[var(--ink)] hover:border-[var(--ink-3)] no-underline transition-colors duration-150"
          >
            {t('trace_back_to_result')}
          </a>
        </div>
      </div>
    </main>
  );
}
