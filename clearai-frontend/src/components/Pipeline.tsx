/**
 * Pipeline — the 6-stage progress visualization.
 *
 * Stage labels + default timings mirror the v5 design. Timings are
 * cosmetic while the backend is synchronous; once the API returns
 * `stages: [{key, label, duration_ms}]`, we'll render those instead.
 */

export type StageKey = 'parse' | 'retrieve' | 'rank' | 'reason' | 'resolve' | 'emit';

export type StageDef = { key: StageKey; label: string; defaultMs: number };

export const STAGES: StageDef[] = [
  { key: 'parse',    label: 'Read the description',         defaultMs: 320 },
  { key: 'retrieve', label: 'Search the tariff book',       defaultMs: 420 },
  { key: 'rank',     label: 'Rank candidate headings',      defaultMs: 340 },
  { key: 'reason',   label: 'Reason under WCO rules (GIR)', defaultMs: 620 },
  { key: 'resolve',  label: 'Lock the 12-digit code',       defaultMs: 280 },
  { key: 'emit',     label: 'Write rationale and evidence', defaultMs: 260 },
];

type Props = {
  progress: number;   // -1 = idle, 0..STAGES.length-1 = active stage, STAGES.length = done
  show: boolean;
  compact: boolean;
  totalMs?: number;   // optional true total once resolution returns
  traceId?: string;
};

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

export default function Pipeline({ progress, show, compact, totalMs, traceId }: Props) {
  const state = (i: number): 'idle' | 'done' | 'active' | 'pending' =>
    progress < 0 ? 'idle' : i < progress ? 'done' : i === progress ? 'active' : 'pending';
  const pct = progress < 0 ? 0 : Math.min(100, (progress / STAGES.length) * 100);

  return (
    <div className={`pipe ${show ? 'show ' : ''}${compact ? 'done' : ''}`}>
      <div className="pipe-bar"><div className="fill" style={{ width: `${pct}%` }} /></div>

      {compact ? (
        <div className="pipe-done-row">
          <span className="ok">
            Classified{totalMs != null ? ` in ${fmtMs(totalMs)}` : ''} · {STAGES.length} stages
          </span>
          {traceId && <span>trace · {traceId}</span>}
        </div>
      ) : (
        <div className="pipe-list">
          {STAGES.map((s, i) => {
            const st = state(i);
            return (
              <div key={s.key} className={`pipe-row ${st}`}>
                <div className="ic">{st === 'done' ? '✓' : String(i + 1).padStart(2, '0')}</div>
                <div className="lb">{s.label}</div>
                <div className="t">{st === 'done' ? fmtMs(s.defaultMs) : st === 'active' ? '…' : ''}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
