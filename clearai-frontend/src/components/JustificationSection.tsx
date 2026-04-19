/**
 * JustificationSection — renders the 7-section WCO-grounded justification.
 *
 * Sections mirror clearai.ports.reasoner.JustificationResult exactly.
 * Null-safe: returns null if no justification is available (e.g. reasoner
 * failed or credit balance is depleted — the API still returns the code).
 */
import type { Justification } from '../lib/api';

type Props = { justification: Justification | null };

type Section = {
  label: string;
  body: string | string[];
};

export default function JustificationSection({ justification }: Props) {
  if (!justification) return null;

  const sections: Section[] = [
    { label: 'Product name', body: justification.product_name },
    { label: 'Understanding the product', body: justification.understanding_the_product },
    { label: 'Relevant tariff headings', body: justification.relevant_tariff_headings },
    { label: 'Exclusions of other subheadings', body: justification.exclusions_of_other_subheadings },
    { label: 'WCO HS explanatory notes', body: justification.wco_hs_explanatory_notes },
    { label: 'Correct classification', body: justification.correct_classification },
    { label: 'Conclusion', body: justification.conclusion },
  ];

  return (
    <section className="paper p-6 md:p-8">
      <header className="flex items-baseline justify-between mb-5">
        <h2 className="font-display text-xl md:text-2xl text-parchment-900">
          Justification
        </h2>
        <span className="text-xs font-mono uppercase tracking-[0.2em] text-parchment-500">
          WCO-grounded · 7 sections
        </span>
      </header>

      <div className="rule mb-6"></div>

      <dl className="space-y-5">
        {sections.map((s) => (
          <div key={s.label}>
            <dt className="text-xs uppercase tracking-[0.2em] text-parchment-500 font-mono mb-1.5">
              {s.label}
            </dt>
            <dd className="font-display text-parchment-900 leading-relaxed">
              {Array.isArray(s.body) ? (
                s.body.length === 0 ? (
                  <span className="text-parchment-400 italic">(none listed)</span>
                ) : (
                  <ul className="list-disc pl-5 space-y-1">
                    {s.body.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )
              ) : s.body ? (
                s.body
              ) : (
                <span className="text-parchment-400 italic">—</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
