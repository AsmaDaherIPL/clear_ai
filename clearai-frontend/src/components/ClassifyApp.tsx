/**
 * ClassifyApp — the single React island on the homepage.
 *
 * M8 scaffold: wires the form skeleton and API client end-to-end so the
 * plumbing is provably alive. M9 will replace the placeholder result
 * with ResultPanel + JustificationSection + EvidenceDetails.
 */
import { useState } from 'react';
import { api, ApiError, type ResolveResponse } from '../lib/api';

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

export default function ClassifyApp() {
  const [form, setForm] = useState<FormState>(BLANK);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResponse | null>(null);

  function update<K extends keyof FormState>(key: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [key]: v }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await api.resolve({
        description: form.description.trim() || undefined,
        hs_code: form.hs_code.trim() || undefined,
        value: form.value ? Number(form.value) : undefined,
        currency: form.currency || undefined,
        origin: form.origin || undefined,
        destination: form.destination || undefined,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-10">
      <form onSubmit={onSubmit} className="paper p-6 md:p-8 space-y-5">
        <label className="block">
          <span className="text-xs uppercase tracking-[0.2em] text-parchment-500">Merchant description</span>
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
            disabled={loading || (!form.description && !form.hs_code)}
            className="px-6 py-2.5 bg-najdi-600 hover:bg-najdi-700 disabled:bg-parchment-300 disabled:cursor-not-allowed text-parchment-50 font-display font-500 tracking-wide uppercase text-sm rounded transition-colors"
          >
            {loading ? '…' : 'Classify'}
          </button>
        </div>
      </form>

      {error && (
        <div className="paper p-5 border-crimson-500">
          <p className="text-crimson-600 font-mono text-sm">{error}</p>
        </div>
      )}

      {/* M8 placeholder. M9 replaces this with ResultPanel. */}
      {result && (
        <section className="paper p-6 md:p-8 space-y-4">
          <div className="flex items-baseline gap-4">
            <span className="hs-stamp text-2xl">{result.hs_code || '—'}</span>
            <span className="text-xs uppercase tracking-[0.2em] text-parchment-500">
              {result.path} · {Math.round(result.confidence * 100)}%
            </span>
          </div>
          {result.customs_description_en && (
            <p className="font-display text-lg text-parchment-900">{result.customs_description_en}</p>
          )}
          {result.customs_description_ar && (
            <p className="arabic text-lg text-parchment-700">{result.customs_description_ar}</p>
          )}
          {result.error && (
            <p className="text-crimson-600 font-mono text-sm">{result.error}</p>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-parchment-500 font-mono uppercase tracking-wider text-xs">raw response</summary>
            <pre className="mt-3 bg-parchment-100 p-3 rounded overflow-x-auto font-mono text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </div>
  );
}
