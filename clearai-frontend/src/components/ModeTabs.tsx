/**
 * ModeTabs — three product modes mapped 1:1 to backend endpoints:
 *   generate → POST /classify/describe   (free-text → 12-digit code)
 *   expand   → POST /classify/expand     (4/6/8/10-digit prefix + description → 12-digit code)
 *   boost    → POST /boost               (12-digit code → check for a more specific sibling)
 *
 * "Validate" is intentionally absent: there's no backend endpoint for it
 * yet. When that lands we'll add it as a fourth tab.
 */

export type Mode = 'generate' | 'expand' | 'boost';

type ModeDef = {
  key: Mode;
  tag: string;
  ttl: string;
  sub: string;
};

export const MODES: ModeDef[] = [
  {
    key: 'generate',
    tag: '01 · CREATE',
    ttl: 'Generate',
    sub: 'Free-text description → full 12-digit ZATCA code',
  },
  {
    key: 'expand',
    tag: '02 · EXPAND',
    ttl: 'Expand',
    sub: 'Partial code (4/6/8/10 digits) + description → 12-digit code',
  },
  {
    key: 'boost',
    tag: '03 · SHARPEN',
    ttl: 'Boost',
    sub: 'Already have a 12-digit code? Check for a more specific sibling',
  },
];

type Props = { mode: Mode; setMode: (m: Mode) => void };

export default function ModeTabs({ mode, setMode }: Props) {
  return (
    <div className="modes-wrap">
      <div className="modes">
        {MODES.map((m) => (
          <button
            key={m.key}
            className={`mode ${mode === m.key ? 'on' : ''}`}
            onClick={() => setMode(m.key)}
            type="button"
          >
            <div className="mtag">{m.tag}</div>
            <div className="mttl">{m.ttl}</div>
            <div className="msub">{m.sub}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
