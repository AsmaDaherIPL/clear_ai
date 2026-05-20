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
    if (!valueAmount) return null;
    const n = Number(valueAmount);
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
      className={cn(className)}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${valueRequired ? 'oklch(0.58 0.20 25)' : '#d6ccc4'}`,
        borderRadius: 20,
        boxShadow: '0 4px 16px rgba(35,25,21,0.04)',
        transition: 'border-color 140ms ease, box-shadow 160ms ease',
      }}
    >
      {/* Textarea pane — generate + expand modes. */}
      {mode !== 'batch' && (
        <div>
          <div style={{ padding: '16px 16px 0' }}>
            <textarea
              rows={1}
              value={description}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) =>
                setDescription(e.target.value.slice(0, DESCRIPTION_MAX))
              }
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder={t('placeholder')}
              className={cn(
                'w-full border-0 outline-none bg-transparent',
                'text-[16px] leading-[1.55] text-[var(--ink)]',
                'min-h-[28px] max-h-[200px] font-[inherit]',
                'placeholder:text-[var(--ink-3)]',
                'resize-none',
              )}
              style={{ padding: '6px 4px 8px' }}
            />
          </div>

          {/*
            Char counter in a small strip — only when at cap, hidden otherwise.
          */}
          {atCap && (
            <div className="flex justify-end px-[18px] pb-1">
              <span
                className="text-[11px] text-[oklch(0.45_0.14_30)]"
                aria-live="polite"
                style={{ fontFamily: "'IBM Plex Mono', monospace" }}
              >
                {charCount} / {DESCRIPTION_MAX}
              </span>
            </div>
          )}

          {/*
            Chip row — sits at the bottom of the textarea card.
            VALUE chip (left) + HS hint chip (center/flex) + submit button (right).
            Always shown in generate + expand modes.
          */}
          {(mode === 'generate' || mode === 'expand') && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '6px 10px 10px',
                marginTop: 6,
              }}
            >
              {/* Left chip group */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>

                {/* ChatChip: payments icon + Value label + numeric input + currency select */}
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 14px',
                    height: 38,
                    background: valueRequired ? 'oklch(0.96 0.03 25)' : '#f6f2ed',
                    border: valueRequired ? '1px solid oklch(0.58 0.20 25)' : '1px solid #e0d6ce',
                    borderRadius: 999,
                    fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
                    fontSize: 13,
                    color: '#7a6d65',
                    flexShrink: 0,
                    transition: 'border-color 140ms ease, background 140ms ease',
                  }}
                >
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                    style={{
                      fontSize: 15,
                      fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 16",
                      color: '#7a6d65',
                      lineHeight: 1,
                      flexShrink: 0,
                      userSelect: 'none',
                    }}
                  >
                    payments
                  </span>
                  <label
                    htmlFor="composer-value"
                    style={{
                      fontWeight: 500,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      userSelect: 'none',
                    }}
                  >
                    {t('value_label' as TKey)}
                  </label>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#231915' }}>
                    <input
                      id="composer-value"
                      type="number"
                      inputMode="decimal"
                      value={valueAmount}
                      onChange={(e) => {
                        if (valueRequired) setValueRequired(false);
                        setValueAmount(e.target.value);
                      }}
                      placeholder="0"
                      aria-invalid={valueRequired}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        width: 70,
                        border: 0,
                        outline: 'none',
                        background: 'transparent',
                        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
                        fontSize: 13,
                        fontWeight: 500,
                        color: valueRequired ? 'oklch(0.45 0.18 25)' : '#231915',
                        padding: 0,
                        appearance: 'none',
                      }}
                    />
                    <select
                      aria-label={t('value_label' as TKey)}
                      value={currencyCode}
                      onChange={(e) => setCurrencyCode(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        width: 56,
                        appearance: 'none',
                        WebkitAppearance: 'none',
                        border: 0,
                        outline: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
                        fontSize: 13,
                        fontWeight: 600,
                        color: '#231915',
                        padding: 0,
                        flexShrink: 0,
                      }}
                    >
                      {currencies.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </span>
                </div>

                {/* PartialHsChip: tag icon + "HS hint" static label + mono input */}
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 14px',
                    height: 38,
                    background: parentCode ? '#fff1e5' : '#f6f2ed',
                    border: `1px solid ${parentCode ? '#b8551b' : '#e0d6ce'}`,
                    borderRadius: 999,
                    fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
                    fontSize: 13,
                    transition: 'background 140ms ease, border-color 140ms ease',
                  }}
                >
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                    style={{
                      fontSize: 15,
                      fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 16",
                      color: parentCode ? '#b8551b' : '#7a6d65',
                      lineHeight: 1,
                      flexShrink: 0,
                      userSelect: 'none',
                      transition: 'color 140ms ease',
                    }}
                  >
                    tag
                  </span>
                  <span style={{ fontWeight: 500, color: parentCode ? '#7a3000' : '#7a6d65', whiteSpace: 'nowrap', userSelect: 'none' }}>
                    HS hint
                  </span>
                  <input
                    id="composer-parent"
                    type="text"
                    inputMode="numeric"
                    value={parentCode}
                    onChange={(e) => setParentCode(e.target.value.replace(/\D/g, '').slice(0, 12))}
                    placeholder="e.g. 8517130000"
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: 160,
                      border: 0,
                      outline: 'none',
                      background: 'transparent',
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 13,
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      color: parentCode ? '#7a3000' : '#231915',
                      padding: 0,
                    }}
                    className="composer-hs-input"
                  />
                </div>

              </div>

              {/* Submit button — 38px round, orange when active, muted when empty */}
              {(() => {
                const isDisabled = loading || !description.trim() || !parentCodeValid || !valueAmountValid;
                return (
                  <button
                    type="submit"
                    aria-label={loading ? t('act_classifying' as TKey) : t('nav_classify' as TKey)}
                    disabled={isDisabled}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: '50%',
                      background: isDisabled ? '#f6f2ed' : '#b8551b',
                      color: isDisabled ? '#a3958c' : '#fff',
                      border: 0,
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      transition: 'background 140ms ease',
                    }}
                  >
                    {loading ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" width={18} height={18} className="animate-spin" aria-hidden="true">
                        <path d="M12 2a10 10 0 0 1 10 10" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width={18} height={18} aria-hidden="true" className="rtl:scale-x-[-1]">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                    )}
                  </button>
                );
              })()}
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

</>
  );
}
