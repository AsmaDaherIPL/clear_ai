/**
 * ModeTabs — 3 product modes. Only "generate" is live; Boost + Validate
 * render a coming-soon card.
 */

export type Mode = 'generate' | 'boost' | 'validate';

type ModeDef = {
  key: Mode;
  tag: string;
  ttl: string;
  sub: string;
  state: 'live' | 'soon';
};

export const MODES: ModeDef[] = [
  { key: 'generate', tag: '01 · CREATE',   ttl: 'Generate', sub: 'No code yet — build one from your description',       state: 'live' },
  { key: 'boost',    tag: '02 · SHARPEN',  ttl: 'Boost',    sub: 'Code too generic — drill down to submission precision', state: 'soon' },
  { key: 'validate', tag: '03 · AUDIT',    ttl: 'Validate', sub: 'Ready to submit — check everything is consistent',     state: 'soon' },
];

type Props = { mode: Mode; setMode: (m: Mode) => void };

export default function ModeTabs({ mode, setMode }: Props) {
  return (
    <div className="modes-wrap">
      <div className="modes">
        {MODES.map((m) => (
          <button
            key={m.key}
            className={`mode ${mode === m.key ? 'on ' : ''}${m.state === 'soon' ? 'soon' : ''}`}
            onClick={() => setMode(m.key)}
            type="button"
          >
            <div className="mtag">{m.tag}</div>
            <div className="mttl">{m.ttl}</div>
            <div className="msub">{m.sub}</div>
            {m.state === 'soon' && <span className="soonchip">SOON</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
