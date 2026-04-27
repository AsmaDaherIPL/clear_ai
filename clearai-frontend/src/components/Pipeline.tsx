/**
 * Pipeline — honest in-flight indicator.
 *
 * Earlier versions rendered six fake "stages" (Read the description / Search
 * the tariff book / Rank candidate headings / Reason under WCO rules (GIR) /
 * Lock the 12-digit code / Write rationale and evidence) with hand-tuned
 * default millisecond budgets that ticked on a fixed timeline regardless of
 * what the backend was actually doing. The labels also implied phase work
 * (e.g. "Reason under WCO rules (GIR)") that did not map to any backend
 * step — `evaluateGate` is a numeric threshold check, not GIR reasoning;
 * the actual GIR-style adjudication happens inside the LLM call.
 *
 * The backend currently returns a single envelope with one total latency,
 * not a stream of phase events. Until that changes (SSE-backed real
 * progress is a v1.5 candidate), the only honest UI is:
 *   - while in flight: indeterminate motion + the two phases that ARE
 *     observable to the user (search + reason)
 *   - on completion: the real round-trip latency from the response
 *
 * Two visible labels beat six lying ones. If/when the backend streams
 * `phase_started` / `phase_done` events, swap this for a real driven view.
 *
 * `STAGES` is exported only as a `length` source for legacy callers in
 * ClassifyApp during the transition; remove that import in a follow-up.
 */

export type StageKey = 'search' | 'reason';

type Phase = StageKey | null;

export const STAGES = [{ key: 'search' }, { key: 'reason' }] as const;

type Props = {
  /** Current phase, or null when idle. */
  phase: Phase;
  /** Total round-trip in ms once the response arrives, else null. */
  totalMs: number | null;
  /** Whether to render at all (parent owns mount/unmount transitions). */
  show: boolean;
};

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

const ROWS: Array<{ key: StageKey; label: string; help: string }> = [
  {
    key: 'search',
    label: 'Searching the tariff book',
    help: 'Embedding your description and ranking candidate codes from 19,105 leaves',
  },
  {
    key: 'reason',
    label: 'Reasoning over candidates',
    help: 'Asking Claude (Foundry) to apply WCO General Interpretive Rules to the shortlist',
  },
];

export default function Pipeline({ phase, totalMs, show }: Props) {
  const done = totalMs !== null;

  return (
    <div className={`pipe ${show ? 'show' : ''}`}>
      <div className="pipe-bar">
        <div
          className={`fill ${done ? 'done' : 'indeterminate'}`}
          style={done ? { width: '100%' } : undefined}
        />
      </div>
      <div className="pipe-list">
        {ROWS.map((r) => {
          const isActive = !done && phase === r.key;
          const isDone = done || (phase !== null && rowIndex(r.key) < rowIndex(phase));
          const cls = done ? 'done' : isActive ? 'active' : isDone ? 'done' : 'pending';
          return (
            <div key={r.key} className={`pipe-row ${cls}`} title={r.help}>
              <div className="ic">{cls === 'done' ? '✓' : cls === 'active' ? '…' : '·'}</div>
              <div className="lb">{r.label}</div>
              <div className="t">{cls === 'active' ? '…' : ''}</div>
            </div>
          );
        })}
        {totalMs !== null && (
          <div className="pipe-row total">
            <div className="ic">∑</div>
            <div className="lb">Total round-trip</div>
            <div className="t">{fmtMs(totalMs)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function rowIndex(p: Phase): number {
  if (p === 'search') return 0;
  if (p === 'reason') return 1;
  return -1;
}
