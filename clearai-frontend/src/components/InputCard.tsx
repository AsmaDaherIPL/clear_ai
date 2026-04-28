/**
 * InputCard — mode-aware input surface.
 *
 * Generate:  one textarea (free-text description).
 * Expand:    HS prefix (4/6/8/10 digits) + description textarea.
 * Boost:     one numeric input (exactly 12 digits), no description.
 *
 * The currency/value pill from the legacy v5 design has been removed —
 * the Fastify backend doesn't take a value, and showing fields the API
 * ignores would lie to the user.
 */
import { useEffect, useRef } from 'react';
import type { Mode } from './ModeTabs';

type Props = {
  mode: Mode;
  text: string;
  setText: (s: string) => void;
  hsCode: string;
  setHsCode: (s: string) => void;
  busy: boolean;
  onSubmit: () => void;
};

export default function InputCard({
  mode, text, setText, hsCode, setHsCode, busy, onSubmit,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Focus the most relevant control when mode changes.
  useEffect(() => {
    if (mode === 'boost') codeRef.current?.focus();
    else if (mode === 'expand') codeRef.current?.focus();
    else taRef.current?.focus();
  }, [mode]);

  const canRun = (() => {
    if (mode === 'generate') return text.trim().length > 0;
    if (mode === 'expand') return /^\d{6,10}$/.test(hsCode) && text.trim().length > 0;
    return /^\d{12}$/.test(hsCode); // boost
  })();

  function onTextKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canRun && !busy) onSubmit();
    }
  }
  function onCodeKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (canRun && !busy) onSubmit();
    }
  }

  const codePlaceholder =
    mode === 'boost' ? 'e.g. 010121100000 (exactly 12 digits)' : 'e.g. 010121 / 3304993 / 01012110';
  const codeLabel =
    mode === 'boost' ? '12-digit ZATCA code under inspection' : 'Parent code';
  const codeHint =
    mode === 'boost'
      ? "we'll search siblings under the same parent for a better match"
      : "we'll narrow within this branch to a 12-digit leaf";

  // Generate uses textarea only; Expand uses code + textarea; Boost uses code only.
  const showText = mode !== 'boost';
  const showCode = mode !== 'generate';
  const codeMaxLen = mode === 'boost' ? 12 : 10;

  return (
    <div className="card">
      {showText && (
        <div className="peer">
          <div className="peer-head">
            <span>Describe the product</span>
            <span className="hint">plain language — EN or AR</span>
          </div>
          <textarea
            ref={taRef}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onTextKey}
            placeholder="e.g. Live horse, purebred breeding stock, mare"
          />
        </div>
      )}

      {showText && showCode && <div className="or-rule"><span>+</span></div>}

      {showCode && (
        <div className="peer">
          <div className="peer-head">
            <span>{codeLabel}</span>
            <span className="hint">{codeHint}</span>
          </div>
          <input
            ref={codeRef}
            className="hs-input"
            value={hsCode}
            onChange={(e) => setHsCode(e.target.value.replace(/\D/g, '').slice(0, codeMaxLen))}
            onKeyDown={onCodeKey}
            placeholder={codePlaceholder}
            inputMode="numeric"
          />
        </div>
      )}

      <div className="card-bar">
        <div className="l">
          {/* Slot kept for future "advanced options" pill. */}
        </div>
        <div className="r">
          <button
            className="btn-classify btn-classify-lg"
            onClick={onSubmit}
            disabled={busy || !canRun}
            type="button"
          >
            {busy
              ? 'Classifying…'
              : mode === 'generate'
                ? 'Classify'
                : mode === 'expand'
                  ? 'Expand'
                  : 'Boost'}
            <span className="kb">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
