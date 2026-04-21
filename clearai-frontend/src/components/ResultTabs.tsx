/**
 * ResultTabs — two tabs beneath the HS code card:
 *   A · Descriptions — ZATCA EN/AR + product EN/AR, bilingual grid
 *   B · Explained   — 3-step rationale + sources cited
 *
 * The v5 design shows structured rationale steps + a sources panel. When the
 * backend returns `rationale_steps` + `sources`, we render those verbatim.
 * Until then, we fall back to the 7-section `justification` + raw FAISS
 * evidence — same data, shaped for the old layout.
 */
import { useState } from 'react';
import type { ResolveResponse, RationaleStep, EvidenceItem } from '../lib/api';
import InlineBold from './InlineBold';

type Props = { result: ResolveResponse; merchantDescription: string };

type Tab = 'desc' | 'why';

function EvRow({ item }: { item: EvidenceItem }) {
  const src = item.source ?? 'FAISS tariff index';
  const link = item.hs_code;
  const title = item.title ?? item.description_en ?? '—';
  const snip = item.snippet ?? item.description_ar ?? '';
  return (
    <div className="ev-row">
      <div>
        <div className="ev-src">
          <span className="d" />
          <span>{src}</span>
          <span style={{ color: 'var(--mute-3)' }}>·</span>
          <span>{link}</span>
        </div>
        <div className="tt">{title}</div>
        {snip && <div className="snip">{snip}</div>}
      </div>
      <div className="ev-sim">
        <span className="s">{item.score.toFixed(2)}</span>
        <div className="bar"><div className="fill" style={{ width: `${Math.max(0, Math.min(1, item.score)) * 100}%` }} /></div>
      </div>
    </div>
  );
}

function RationaleBlock({ steps }: { steps: RationaleStep[] }) {
  return (
    <div className="rat">
      {steps.map((r, i) => (
        <div key={i} className="r-item">
          <div className="n">{String(i + 1).padStart(2, '0')}</div>
          <div>
            <div className="t">{r.title}</div>
            <div className="d">{r.detail}</div>
            {r.plain_explanation && (
              <div className="pe"><InlineBold md={r.plain_explanation} /></div>
            )}
            {r.reference && <span className="ref">{r.reference}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function JustificationFallback({ result }: { result: ResolveResponse }) {
  const j = result.justification;
  if (!j) return (
    <p style={{ color: 'var(--mute-1)', fontSize: 14 }}>
      Reasoning unavailable for this classification.
    </p>
  );
  // Collapse the 7-section justification into the v5 3-step visual shape.
  const steps: RationaleStep[] = [
    {
      title: 'Understanding the product',
      detail: j.understanding_the_product,
      plain_explanation: '',
      reference: j.product_name,
    },
    {
      title: 'Relevant tariff headings',
      detail: j.relevant_tariff_headings.join(' · ') || '—',
      plain_explanation: j.exclusions_of_other_subheadings.length
        ? `**Excluded:** ${j.exclusions_of_other_subheadings.join('; ')}`
        : '',
      reference: 'WCO GIR',
    },
    {
      title: 'Correct classification',
      detail: j.correct_classification || j.conclusion,
      plain_explanation: j.wco_hs_explanatory_notes ? `**WCO notes:** ${j.wco_hs_explanatory_notes}` : '',
      reference: result.hs_code,
    },
  ];
  return <RationaleBlock steps={steps} />;
}

export default function ResultTabs({ result, merchantDescription }: Props) {
  const [tab, setTab] = useState<Tab>('desc');

  const zatcaEn = result.customs_description_en || '—';
  const zatcaAr = result.customs_description_ar || '—';
  const prodEn = result.product_description_en ?? (merchantDescription || '—');
  const prodAr = result.product_description_ar ?? '—';

  return (
    <div className="tabs">
      <div className="tabs-head">
        <button className={`tabbtn ${tab === 'desc' ? 'on' : ''}`} onClick={() => setTab('desc')} type="button">
          <span className="tn">A · DESCRIPTIONS</span>EN + AR
        </button>
        <button className={`tabbtn ${tab === 'why' ? 'on' : ''}`} onClick={() => setTab('why')} type="button">
          <span className="tn">B · EXPLAINED</span>Reasoning & sources
        </button>
      </div>

      <div className="tabs-body">
        {tab === 'desc' && (
          <div className="desc-grid">
            <div className="desc-cell"><span className="k">ZATCA description · EN</span>{zatcaEn}</div>
            <div className="desc-cell rtl" dir="rtl"><span className="k">ZATCA description · AR</span>{zatcaAr}</div>
            <div className="desc-cell"><span className="k">Product description · EN</span>{prodEn}</div>
            <div className="desc-cell rtl" dir="rtl"><span className="k">Product description · AR</span>{prodAr}</div>
          </div>
        )}

        {tab === 'why' && (
          <div>
            {result.rationale_steps && result.rationale_steps.length > 0
              ? <RationaleBlock steps={result.rationale_steps} />
              : <JustificationFallback result={result} />
            }

            {result.evidence.length > 0 && (
              <div className="sources">
                <div className="head">Sources cited</div>
                {result.evidence.slice(0, 3).map((e) => (
                  <EvRow key={`${e.rank}-${e.hs_code}`} item={e} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
