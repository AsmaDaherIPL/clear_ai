/** Main classify input area: textarea, optional parent-code field, batch dropzone. */

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { ClassifyMode } from './ModeTabs';
import type { TKey } from '@/lib/i18n';

export interface ComposerExtras {
  /** Positive numeric value. Always set after submit-time validation. */
  valueAmount: number;
  /** ISO 4217 3-letter code (uppercase). Always set. */
  currencyCode: string;
}

interface ComposerProps {
  mode: ClassifyMode;
  onSubmit?: (description: string, parentCode?: string, extras?: ComposerExtras) => void;
  /** Batch-mode callback. Fires when the user drops or selects a CSV/XLSX. */
  onPickFile?: (file: File) => void;
  loading?: boolean;
  className?: string;
}

const BATCH_ACCEPT = '.csv,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BATCH_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB — backend caps row count separately

/** Mirrors backend zod cap; keep in lock-step with `describeBody` / `expandBody`. */
const DESCRIPTION_MAX = 250;

/**
 * Currency list comes from GET /reference-data/currencies — same response
 * for both UI languages (3-letter ISO codes, no symbols or translations).
 *
 * FALLBACK_CURRENCIES is what we render before the fetch resolves AND if
 * the fetch fails. Keeps the form usable offline / in dev / during APIM
 * blips. Same default selection ('SAR') in both cases.
 */
const FALLBACK_CURRENCIES = ['SAR', 'USD', 'EUR', 'AED', 'GBP'] as const;

/**
 * Module-level cache so navigating between routes / re-mounting the
 * Composer doesn't re-fetch the list. Resolves once per page load.
 */
let currenciesCache: string[] | null = null;
let currenciesPromise: Promise<string[]> | null = null;

function loadCurrencies(): Promise<string[]> {
  if (currenciesCache) return Promise.resolve(currenciesCache);
  if (currenciesPromise) return currenciesPromise;
  currenciesPromise = api
    .getReferenceCurrencies()
    .then((res) => {
      const list = Array.isArray(res.currencies) && res.currencies.length > 0
        ? res.currencies
        : [...FALLBACK_CURRENCIES];
      currenciesCache = list;
      return list;
    })
    .catch(() => {
      // Network/APIM error — fall through to the static list so the
      // form stays usable. Don't cache the failure (next mount can retry).
      currenciesPromise = null;
      return [...FALLBACK_CURRENCIES];
    });
  return currenciesPromise;
}

export default function Composer({ mode, onSubmit, onPickFile, loading, className }: ComposerProps) {
  const t = useT();
  const [description, setDescription] = useState('');
  const [parentCode, setParentCode] = useState('');
  const [valueAmount, setValueAmount] = useState('');
  const [currencyCode, setCurrencyCode] = useState<string>('SAR');
  // Currencies list — starts as the static fallback, swaps to the API
  // response once the fetch resolves. The default selection ('SAR') is
  // present in both so no flash of "invalid selection" during the swap.
  const [currencies, setCurrencies] = useState<string[]>(() =>
    currenciesCache ?? [...FALLBACK_CURRENCIES]
  );
  useEffect(() => {
    let cancelled = false;
    void loadCurrencies().then((list) => {
      if (cancelled) return;
      setCurrencies(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [batchFile, setBatchFile] = useState<File | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  // Tracks whether the user has attempted to submit with a missing value.
  // Set to true on submit when value is empty; cleared the moment they type.
  const [valueRequired, setValueRequired] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const charCount = description.length;
  const atCap = charCount >= DESCRIPTION_MAX;
  const PARENT_CODE_MIN = 4;
  const parentCodeValid = mode !== 'expand' || parentCode.length >= PARENT_CODE_MIN;
  const parsedValueAmount = (() => {
    const trimmed = valueAmount.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const valueAmountValid = mode === 'batch' || parsedValueAmount !== null;

  const acceptFile = (file: File): void => {
    setBatchError(null);
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx')) {
      setBatchError('Only .csv or .xlsx files are accepted.');
      return;
    }
    if (file.size > BATCH_MAX_BYTES) {
      setBatchError(`File is too large (max ${Math.round(BATCH_MAX_BYTES / 1024 / 1024)} MiB).`);
      return;
    }
    setBatchFile(file);
    onPickFile?.(file);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = description.trim();
    if (!trimmed) return;
    if (!parentCodeValid) return;
    if (parsedValueAmount === null) {
      // Surface the missing-value error and focus the input.
      setValueRequired(true);
      document.getElementById('composer-value')?.focus();
      return;
    }
    setValueRequired(false);
    const extras: ComposerExtras = {
      valueAmount: parsedValueAmount,
      currencyCode,
    };
    onSubmit?.(
      trimmed,
      mode === 'expand' ? parentCode.trim() || undefined : undefined,
      extras,
    );
  };

  return (
    <>
    <form
      onSubmit={handleSubmit}
      className={cn(
        'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)]',
        'shadow-[var(--shadow-lift)] text-start',
        'transition-[border-color,box-shadow] duration-150',
        'focus-within:border-[oklch(0.78_0.008_70)]',
        'focus-within:shadow-[0_8px_30px_-10px_rgba(40,28,18,0.16),0_1px_2px_rgba(20,16,12,0.04)]',
        className,
      )}
    >
      {/* Textarea pane — generate + expand modes. */}
      {mode !== 'batch' && (
        <div>
          <div className="px-[22px] pt-[22px] pb-2">
            <textarea
              rows={2}
              value={description}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) =>
                // Truncate in state — paste can bypass the maxLength attribute.
                setDescription(e.target.value.slice(0, DESCRIPTION_MAX))
              }
              onKeyDown={(e) => {
                // Enter submits, Shift+Enter newlines; skip during IME composition.
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                if (e.shiftKey) return;
                e.preventDefault();
                handleSubmit(e);
              }}
              placeholder={t('placeholder')}
              className={cn(
                'w-full border-0 outline-none resize-none bg-transparent',
                'text-[17px] leading-[1.5] text-[var(--ink)]',
                'min-h-7 max-h-[180px] font-[inherit]',
                'placeholder:text-[var(--ink-3)]',
              )}
            />
          </div>

          {/*
            Unified bottom row — VALUE + currency (left), HS hint (center),
            submit button (right). Always shown in generate + expand modes.
            Replaces the old separate value row, expand HS row, and meta bar.
          */}
          {(mode === 'generate' || mode === 'expand') && (
            <div
              className={cn(
                'flex items-center gap-0 border-t',
                'transition-colors duration-150',
                valueRequired
                  ? 'border-t-[oklch(0.58_0.20_25)]'
                  : 'border-t-[#ede4dc]',
              )}
              style={{ background: '#f6f2ed', padding: '12px 18px' }}
            >
              {/* LEFT: VALUE label + numeric input + currency select */}
              <div className="flex items-center gap-2 shrink-0">
                <label
                  htmlFor="composer-value"
                  className={cn(
                    'shrink-0 transition-colors duration-150',
                    valueRequired ? 'text-[oklch(0.45_0.18_25)]' : 'text-[#a3958c]',
                  )}
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: '11px',
                    fontWeight: 500,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                  }}
                >
                  {t('value_label' as TKey)}
                </label>
                <input
                  id="composer-value"
                  type="text"
                  inputMode="decimal"
                  value={valueAmount}
                  onChange={(e) => {
                    if (valueRequired) setValueRequired(false);
                    const cleaned = e.target.value.replace(/[^0-9.]/g, '');
                    const parts = cleaned.split('.');
                    const next = parts.length > 1
                      ? `${parts[0]}.${parts.slice(1).join('').slice(0, 2)}`
                      : cleaned;
                    setValueAmount(next.slice(0, 12));
                  }}
                  placeholder="0.00"
                  aria-invalid={valueRequired}
                  aria-describedby={valueRequired ? 'composer-value-error' : undefined}
                  className={cn(
                    'border-0 outline-none bg-transparent w-[80px] tracking-[0.02em]',
                    valueRequired
                      ? 'text-[oklch(0.45_0.18_25)] placeholder:text-[oklch(0.70_0.10_25)]'
                      : 'placeholder:text-[#a3958c]',
                  )}
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: '14px',
                    color: valueRequired ? undefined : '#231915',
                  }}
                />
                {valueRequired && (
                  <span
                    id="composer-value-error"
                    role="alert"
                    className="text-[11px] text-[oklch(0.45_0.18_25)] font-medium shrink-0 whitespace-nowrap"
                  >
                    {t('value_required' as TKey)}
                  </span>
                )}
                <select
                  aria-label={t('value_label' as TKey)}
                  value={currencyCode}
                  onChange={(e) => setCurrencyCode(e.target.value)}
                  className={cn(
                    'appearance-none cursor-pointer shrink-0',
                    'bg-[var(--surface)] border border-[var(--line)] rounded-md',
                    'ps-2 pe-6 py-[5px]',
                    'font-mono text-[11px] text-[var(--ink)] tracking-[0.02em]',
                    'focus:outline-2 focus:outline-[var(--accent)] focus:outline-offset-1',
                    "bg-no-repeat bg-[right_8px_center] rtl:bg-[left_8px_center]",
                    "bg-[url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6' fill='none' stroke='%23999' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M1 1l4 4 4-4'/></svg>\")]",
                  )}
                >
                  {currencies.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              {/* CENTER: # icon + HS hint text input (always shown, optional) */}
              <div className="flex-1 flex items-center gap-1.5 px-4 min-w-0">
                <span
                  aria-hidden="true"
                  className="shrink-0 select-none"
                  style={{ color: '#a3958c', fontFamily: "'IBM Plex Mono', monospace", fontSize: '13px' }}
                >
                  #
                </span>
                <input
                  id="composer-parent"
                  type="text"
                  inputMode="numeric"
                  value={parentCode}
                  onChange={(e) => setParentCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  placeholder="HS hint e.g. 8517130000"
                  className="flex-1 min-w-0 border-0 outline-none bg-transparent tracking-[0.02em] placeholder:text-[#a3958c]"
                  style={{ fontSize: '13px', color: '#231915' }}
                />
              </div>

              {/* RIGHT: submit button — round, orange, 40px */}
              <button
                type="submit"
                aria-label={loading ? t('act_classifying' as TKey) : t('nav_classify' as TKey)}
                disabled={loading || !description.trim() || !parentCodeValid || !valueAmountValid}
                className={cn(
                  'shrink-0 rounded-full border-0',
                  'inline-flex items-center justify-center',
                  'shadow-[0_1px_0_rgba(0,0,0,0.06),0_4px_12px_-3px_rgba(184,85,27,0.45)]',
                  'transition-[transform,filter] duration-150',
                  'hover:brightness-110 active:scale-95',
                  'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:scale-100',
                  'rtl:[&_svg]:scale-x-[-1]',
                )}
                style={{ background: '#b8551b', width: '40px', height: '40px' }}
              >
                {loading ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    className="w-[18px] h-[18px] animate-spin"
                    aria-hidden="true"
                  >
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-[18px] h-[18px]"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                )}
              </button>
            </div>
          )}

          {/*
            Char counter in a small strip — only when at cap, hidden otherwise.
            Keeps the textarea-only block clean; the meta line below the card
            replaces the old bottom meta bar.
          */}
          {atCap && (
            <div className="flex justify-end px-[18px] pb-2">
              <span
                className="text-[11px] text-[oklch(0.45_0.14_30)]"
                aria-live="polite"
                style={{ fontFamily: "'IBM Plex Mono', monospace" }}
              >
                {charCount} / {DESCRIPTION_MAX}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Batch dropzone pane. */}
      {mode === 'batch' && (
        <div className="p-3.5">
          <div className="flex items-center justify-end gap-3 pb-2 text-[12.5px] text-[var(--ink-3)]">
            <span>Need the column shape?</span>
            <a
              href="/templates/clearai-batch-template.xlsx"
              download
              className="underline hover:text-[var(--ink-2)]"
            >
              Excel template
            </a>
            <span aria-hidden>·</span>
            <a
              href="/templates/clearai-batch-template.csv"
              download
              className="underline hover:text-[var(--ink-2)]"
            >
              CSV template
            </a>
          </div>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!loading) setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              if (loading) return;
              const file = e.dataTransfer.files?.[0];
              if (file) acceptFile(file);
            }}
            className={cn(
              'border-[1.5px] border-dashed rounded-[var(--radius)]',
              'py-11 px-6',
              'flex flex-col items-center gap-2.5 text-center',
              'transition-[border-color,background] duration-150',
              isDragOver
                ? 'border-[var(--accent)] bg-[oklch(0.97_0.04_60)]'
                : 'border-[var(--line)] bg-[var(--line-2)]',
            )}
          >
            <span className="w-[38px] h-[38px] rounded-full bg-[var(--surface)] border border-[var(--line)] inline-flex items-center justify-center text-[var(--ink-2)]">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </span>
            <h3 className="m-0 mt-1 text-[18px] font-medium tracking-[-0.01em] text-[var(--ink)]">
              {batchFile ? batchFile.name : t('drop_title')}
            </h3>
            <p className="m-0 text-[13px] text-[var(--ink-3)]">
              {batchFile
                ? `${(batchFile.size / 1024).toFixed(1)} KB · ready to submit`
                : t('drop_hint')}
            </p>
            {batchError && (
              <p className="m-0 text-[13px] text-[var(--accent-ink)]" role="alert">
                {batchError}
              </p>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={BATCH_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) acceptFile(file);
                // Reset so the same filename can be re-picked.
                e.target.value = '';
              }}
            />
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                disabled={loading}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'border-0',
                  'bg-[var(--accent)] text-white',
                  'px-[18px] py-2.5 rounded-full',
                  'text-[13.5px] font-medium',
                  'shadow-[0_4px_10px_-3px_rgba(233,123,58,0.4)]',
                  'hover:bg-[var(--accent-ink)] transition-colors duration-150',
                  'disabled:opacity-50 disabled:pointer-events-none',
                )}
              >
                {batchFile ? 'Replace file' : t('drop_browse')}
              </button>
              {batchFile && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setBatchFile(null);
                    setBatchError(null);
                  }}
                  className={cn(
                    'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)]',
                    'px-[18px] py-2.5 rounded-full text-[13.5px] font-medium',
                    'hover:border-[var(--ink-3)] hover:text-[var(--ink)] transition-colors duration-150',
                    'disabled:opacity-50 disabled:pointer-events-none',
                  )}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </form>

    {/* Meta bar below the card — keyboard hint (left) + powered-by (right). */}
    {mode !== 'batch' && (
      <div className="flex items-center justify-between gap-2 pt-2 px-1">
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: '12px',
            color: '#a3958c',
          }}
        >
          {/* Keyboard shortcut — not a translatable label, it's a key binding */}
          x + &#8593; to classify
        </span>
        <span
          style={{
            fontFamily: "'IBM Plex Sans', sans-serif",
            fontSize: '12px',
            color: '#a3958c',
          }}
        >
          {t('composer_powered_by' as TKey)}
        </span>
      </div>
    )}
    </>
  );
}
