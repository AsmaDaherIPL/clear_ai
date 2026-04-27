/**
 * ModeTabs — product modes mapped to backend endpoints.
 *
 *   generate → POST /classify/describe   (free-text → 12-digit code)
 *   expand   → POST /classify/expand     (partial code + description → 12-digit)
 *   boost    → POST /boost               (12-digit → check for better sibling)
 *
 * The third visible tile is intentionally a non-interactive "Validate ·
 * coming soon" teaser. Boost is hidden from the UI for now (the endpoint
 * still works programmatically; the Mode union keeps it for type safety
 * and any future re-exposure). When the validate endpoint ships we'll
 * promote this tile to a real tab.
 */

export type Mode = 'generate' | 'expand' | 'boost';

type ModeDef = {
  key: Mode;
  tag: string;
  ttl: string;
  sub: string;
};

/** Selectable modes — boost is currently hidden behind the Validate teaser. */
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
];

/** Long-form tooltip copy for the Validate teaser. Native `title=` so we
 *  don't pull in a popover dep just for one tile. */
const VALIDATE_TOOLTIP = [
  'For declarations that are ready to submit. ClearAI verifies that your',
  'HS code, description, and declared value tell a consistent story —',
  'flagging mismatches, implausible values, and suspicious combinations',
  'before they reach Bayan.',
  '',
  'When to use:',
  '· Final pre-submission coherence check before Bayan',
  '· Compliance screening for suspicious code-description-value combinations',
].join('\n');

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

        <button
          className="mode soon"
          type="button"
          aria-disabled="true"
          disabled
          title={VALIDATE_TOOLTIP}
        >
          <span className="soonchip">COMING NEXT</span>
          <div className="mtag">03 · VERIFY</div>
          <div className="mttl">Validate</div>
          <div className="msub">
            Pre-Bayan coherence check across HS code, description, and declared value
          </div>
        </button>
      </div>
    </div>
  );
}
