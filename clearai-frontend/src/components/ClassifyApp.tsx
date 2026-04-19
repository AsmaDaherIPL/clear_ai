/**
 * ClassifyApp — the single React island on the homepage.
 *
 * Orchestrates ClassifyForm → api.resolve → ResultPanel +
 * JustificationSection + EvidenceDetails. Stays lean: state is just
 * {loading, error, result}. All presentation lives in the children.
 */
import { useState } from 'react';
import { api, ApiError, type ResolveRequest, type ResolveResponse } from '../lib/api';
import ClassifyForm from './ClassifyForm';
import ResultPanel from './ResultPanel';
import JustificationSection from './JustificationSection';
import EvidenceDetails from './EvidenceDetails';

export default function ClassifyApp() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResponse | null>(null);

  async function handleSubmit(req: ResolveRequest) {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await api.resolve(req);
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network error — is the backend running on :8787?');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-8">
      <ClassifyForm loading={loading} onSubmit={handleSubmit} />

      {error && (
        <div className="paper p-5 border-l-4 border-crimson-500">
          <p className="text-crimson-600 font-mono text-sm">{error}</p>
        </div>
      )}

      {result && (
        <div className="space-y-8 animate-in">
          <ResultPanel result={result} />
          <JustificationSection justification={result.justification} />
          <EvidenceDetails items={result.evidence} chosenCode={result.hs_code} />
        </div>
      )}
    </div>
  );
}
