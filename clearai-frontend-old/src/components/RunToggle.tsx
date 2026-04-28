/**
 * RunToggle — single-item vs batch lane switch.
 *
 * Two big radio cards from the v5 design (`.run-toggle` / `.rt`). Sits
 * directly under the Hero+ModeTabs section, above the input card, so the
 * user picks "single" or "batch" before they engage with the working
 * surface.
 *
 * The "Batch" lane is currently UI-only — the v1 Fastify backend does not
 * expose a batch endpoint. When the batch lane lights up properly we'll
 * wire it through here without changing the toggle's API.
 */

export type RunMode = 'single' | 'batch';

type Props = {
  runMode: RunMode;
  setRunMode: (m: RunMode) => void;
};

export default function RunToggle({ runMode, setRunMode }: Props) {
  return (
    <div className="run-toggle">
      <button
        type="button"
        className={`rt ${runMode === 'single' ? 'on' : ''}`}
        onClick={() => setRunMode('single')}
        aria-pressed={runMode === 'single'}
      >
        <span className="rt-k">01</span>
        <div>
          <div className="rt-t">Single item</div>
          <div className="rt-s">One product description → one HS code</div>
        </div>
      </button>
      <button
        type="button"
        className={`rt ${runMode === 'batch' ? 'on' : ''}`}
        onClick={() => setRunMode('batch')}
        aria-pressed={runMode === 'batch'}
      >
        <span className="rt-k">02</span>
        <div>
          <div className="rt-t">Batch · CSV → ZATCA XML</div>
          <div className="rt-s">Drop a CSV of line items, get a compliant invoice XML</div>
        </div>
      </button>
    </div>
  );
}
