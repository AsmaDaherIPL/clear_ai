/**
 * ClassifyForm — the single input surface.
 *
 * Emits a `ResolveRequest` shape via `onSubmit`. Parent owns loading /
 * error / result state so the form stays dumb.
 */
import { useState } from 'react';
import type { ResolveRequest } from '../lib/api';

type Props = {
  loading: boolean;
  onSubmit: (req: ResolveRequest) => void;
};

type FormState = {
  description: string;
  hs_code: string;
  value: string;
  currency: string;
  origin: string;
  destination: string;
};

const BLANK: FormState = {
  description: '',
  hs_code: '',
  value: '',
  currency: 'USD',
  origin: 'US',
  destination: 'SA',
};

export default function ClassifyForm({ loading, onSubmit }: Props) {
  const [form, setForm] = useState<FormState>(BLANK);
  const disabled = loading || (!form.description.trim() && !form.hs_code.trim());

  function update<K extends keyof FormState>(key: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [key]: v }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit({
      description: form.description.trim() || undefined,
      hs_code: form.hs_code.trim() || undefined,
      value: form.value ? Number(form.value) : undefined,
      currency: form.currency || undefined,
      origin: form.origin || undefined,
      destination: form.destination || undefined,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="paper p-6 md:p-8 space-y-5">
      <label className="block">
        <span className="text-xs uppercase tracking-[0.2em] text-parchment-500">
          Merchant description
        </span>
        <textarea
          value={form.description}
          onChange={(e) => update('description', e.target.value)}
          rows={3}
          placeholder="e.g. Marvel comic book — single issue, printed paperback"
          className="mt-2 w-full bg-parchment-50 border border-parchment-200 rounded px-3 py-2 font-display text-lg focus:border-najdi-500 outline-none"
        />
      </label>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <label className="block col-span-2 md:col-span-1">
          <span className="text-xs uppercase tracking-[0.2em] text-parchment-500">HS hint</span>
          <input
            value={form.hs_code}
            onChange={(e) => update('hs_code', e.target.value.replace(/\D/g, ''))}
            placeholder="optional"
            className="mt-2 w-full bg-parchment-50 border border-parchment-200 rounded px-3 py-2 font-mono focus:border-najdi-500 outline-none"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-[0.2em] text-parchment-500">Value</span>
          <input
            type="number"
            inputMode="decimal"
            value={form.value}
            onChange={(e) => update('value', e.target.value)}
            className="mt-2 w-full bg-parchment-50 border border-parchment-200 rounded px-3 py-2 font-mono focus:border-najdi-500 outline-none"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-[0.2em] text-parchment-500">CCY</span>
          <input
            value={form.currency}
            onChange={(e) => update('currency', e.target.value.toUpperCase().slice(0, 3))}
            className="mt-2 w-full bg-parchment-50 border border-parchment-200 rounded px-3 py-2 font-mono focus:border-najdi-500 outline-none"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-[0.2em] text-parchment-500">Origin &rarr; Dest</span>
          <div className="mt-2 flex gap-1">
            <input
              value={form.origin}
              onChange={(e) => update('origin', e.target.value.toUpperCase().slice(0, 2))}
              className="w-1/2 bg-parchment-50 border border-parchment-200 rounded px-2 py-2 font-mono focus:border-najdi-500 outline-none"
            />
            <input
              value={form.destination}
              onChange={(e) => update('destination', e.target.value.toUpperCase().slice(0, 2))}
              className="w-1/2 bg-parchment-50 border border-parchment-200 rounded px-2 py-2 font-mono focus:border-najdi-500 outline-none"
            />
          </div>
        </label>
      </div>

      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-parchment-500 font-mono">
          {loading ? 'resolving through FAISS + Anthropic…' : 'press classify to resolve'}
        </p>
        <button
          type="submit"
          disabled={disabled}
          className="px-6 py-2.5 bg-najdi-600 hover:bg-najdi-700 disabled:bg-parchment-300 disabled:cursor-not-allowed text-parchment-50 font-display font-500 tracking-wide uppercase text-sm rounded transition-colors"
        >
          {loading ? '…' : 'Classify'}
        </button>
      </div>
    </form>
  );
}
