/** Main classify input area: textarea, optional parent-code field, batch dropzone. */

import { useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ClassifyMode } from './ModeTabs';

export interface ComposerExtras {
  /** Numeric value of the item, parsed from the value input. Undefined when empty. */
  valueAmount?: number;
  /** ISO 4217 3-letter code (uppercase). Undefined when default. */
  currencyCode?: string;
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
const DESCRIPTION_WARN_AT = Math.floor(DESCRIPTION_MAX * 0.9);

const CURRENCIES = ['SAR', 'USD', 'EUR', 'AED', 'GBP', 'CNY', 'JPY', 'INR'] as const;

export default function Composer({ mode, onSubmit, onPickFile, loading, className }: ComposerProps) {
  const t = useT();
  const [description, setDescription] = useState('');
  const [parentCode, setParentCode] = useState('');
  const [valueAmount, setValueAmount] = useState('');
  const [currencyCode, setCurrencyCode] = useState<typeof CURRENCIES[number]>('SAR');
  const [batchFile, setBatchFile] = useState<File | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const charCount = description.length;
  const nearCap = charCount >= DESCRIPTION_WARN_AT;
  const atCap = charCount >= DESCRIPTION_MAX;
  const PARENT_CODE_MIN = 4;
  const parentCodeValid = mode !== 'expand' || parentCode.length >= PARENT_CODE_MIN;

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
    const parsedValue = valueAmount.trim() ? Number(valueAmount) : undefined;
    const extras: ComposerExtras = {
      valueAmount: parsedValue !== undefined && Number.isFinite(parsedValue) && parsedValue > 0
        ? parsedValue
        : undefined,
      currencyCode: currencyCode === 'SAR' ? undefined : currencyCode,
    };
    onSubmit?.(
      trimmed,
      mode === 'expand' ? parentCode.trim() || undefined : undefined,
      extras,
    );
  };

  return (
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

          {/* Expand-only parent code row. */}
          {mode === 'expand' && (
            <div className="flex items-center gap-3 px-[22px] py-2.5 border-t border-[var(--line-2)]">
              <label className="font-mono text-[11px] font-medium text-[var(--ink-3)] tracking-[0.06em] uppercase shrink-0">
                {t('parent_label')}
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={parentCode}
                onChange={(e) => setParentCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="e.g. 010121 / 3304993 / 01012110"
                className="flex-1 border-0 outline-none bg-transparent font-mono text-base text-[var(--ink)] tracking-[0.02em] placeholder:text-[var(--ink-3)]"
              />
            </div>
          )}

          {/* Value + currency row — visible in both Generate and Expand modes. */}
          {/* Optional commercial context fed to /pipeline/dispatch. The backend */}
          {/* Stage 3 sanity check uses this to flag declared values that look */}
          {/* implausible for the chosen HS code (e.g. $0.50 watch). */}
          {(mode === 'generate' || mode === 'expand') && (
            <div className="flex items-center gap-3 px-[22px] py-2.5 border-t border-[var(--line-2)]">
              <label
                htmlFor="composer-value"
                className="font-mono text-[11px] font-medium text-[var(--ink-3)] tracking-[0.06em] uppercase shrink-0"
              >
                Value
              </label>
              <input
                id="composer-value"
                type="text"
                inputMode="decimal"
                value={valueAmount}
                onChange={(e) => {
                  const cleaned = e.target.value.replace(/[^0-9.]/g, '');
                  const parts = cleaned.split('.');
                  const next = parts.length > 1
                    ? `${parts[0]}.${parts.slice(1).join('').slice(0, 2)}`
                    : cleaned;
                  setValueAmount(next.slice(0, 12));
                }}
                placeholder="optional, e.g. 199.50"
                className="flex-1 border-0 outline-none bg-transparent font-mono text-base text-[var(--ink)] tracking-[0.02em] placeholder:text-[var(--ink-3)]"
              />
              <select
                aria-label="Currency"
                value={currencyCode}
                onChange={(e) => setCurrencyCode(e.target.value as typeof CURRENCIES[number])}
                className="border-0 outline-none bg-transparent font-mono text-[13px] text-[var(--ink-2)] tracking-[0.02em] cursor-pointer"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          )}

          {/* Meta bar — char counter + submit. */}
          <div className="flex items-center justify-between gap-2 px-3.5 pb-3.5 pt-2">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'font-mono text-[12px] tabular-nums transition-colors duration-150',
                  atCap
                    ? 'text-[oklch(0.55_0.18_25)] font-medium'
                    : nearCap
                      ? 'text-[oklch(0.62_0.16_60)]'
                      : 'text-[var(--ink-3)]',
                )}
                aria-live="polite"
              >
                {charCount} / {DESCRIPTION_MAX}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="submit"
                aria-label="Classify"
                disabled={loading || !description.trim() || !parentCodeValid}
                className={cn(
                  'w-9 h-9 rounded-full border-0',
                  'bg-[var(--accent)] text-white',
                  'inline-flex items-center justify-center',
                  'shadow-[0_1px_0_rgba(0,0,0,0.04),0_4px_10px_-3px_rgba(233,123,58,0.5)]',
                  'transition-[transform,background] duration-150',
                  'hover:bg-[var(--accent-ink)] active:scale-95',
                  'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[var(--accent)] disabled:active:scale-100',
                  'rtl:[&_svg]:scale-x-[-1]',
                )}
              >
                {loading ? (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    className="w-4 h-4 animate-spin"
                    aria-hidden="true"
                  >
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-4 h-4"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                )}
              </button>
            </div>
          </div>
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
  );
}
