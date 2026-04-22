/**
 * InputCard — the two-peer input surface (description OR HS code),
 * with a value+currency pill, an attach-CSV pill, and the Classify button.
 *
 * Currency is a <select> so the user can pick from a short ISO-4217 list
 * (defaults to USD). Value + Attach + Classify are sized up from the v5
 * reference per product direction — easier to tap and more anchoring.
 */
import { useEffect, useRef } from 'react';

const CURRENCIES = ['USD', 'SAR', 'EUR', 'GBP', 'AED', 'CNY', 'JPY', 'INR'] as const;

type Props = {
  text: string;
  setText: (s: string) => void;
  hsHint: string;
  setHsHint: (s: string) => void;
  value: string;
  setValue: (s: string) => void;
  currency: string;
  setCurrency: (s: string) => void;
  busy: boolean;
  onClassify: () => void;
};

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$', SAR: 'ر.س', EUR: '€', GBP: '£', AED: 'د.إ', CNY: '¥', JPY: '¥', INR: '₹',
};

export default function InputCard({
  text, setText, hsHint, setHsHint,
  value, setValue, currency, setCurrency,
  busy, onClassify,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { taRef.current?.focus(); }, []);

  const canRun = text.trim().length > 0 || hsHint.trim().length > 0;

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canRun && !busy) onClassify();
    }
  }

  const symbol = CURRENCY_SYMBOL[currency] ?? '$';

  return (
    <div className="card">
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
          onKeyDown={onKey}
          placeholder="e.g. Marvel comic book — single issue, printed paperback, 36 pages"
        />
      </div>

      <div className="or-rule"><span>OR</span></div>

      <div className="peer">
        <div className="peer-head">
          <span>HS code you already have</span>
          <span className="hint">partial or full — we'll resolve to 12 digits</span>
        </div>
        <input
          className="hs-input"
          value={hsHint}
          onChange={(e) => setHsHint(e.target.value.replace(/\D/g, '').slice(0, 12))}
          onKeyDown={onKey}
          placeholder="e.g. 4901 or 490110000000"
          inputMode="numeric"
        />
      </div>

      <div className="card-bar">
        <div className="l">
          <span className="pill pill-lg val-pill">
            <span className="plus" aria-hidden>{symbol}</span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Value"
              inputMode="decimal"
              aria-label="Declared value"
            />
            <select
              className="cur-select"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              aria-label="Currency"
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </span>
        </div>
        <div className="r">
          <button
            className="btn-classify btn-classify-lg"
            onClick={onClassify}
            disabled={busy || !canRun}
            type="button"
          >
            {busy ? 'Classifying…' : 'Classify'}
            <span className="kb">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
