/**
 * SoonCard — "coming soon" panel for the Boost / Validate modes.
 */
import type { Mode } from './ModeTabs';

const CONTENT: Record<Exclude<Mode, 'generate'>, {
  chip: string;
  title: string;
  copy: string;
  feats: { k: string; t: string }[];
}> = {
  boost: {
    chip: '02 · SHARPEN',
    title: 'Boost',
    copy: 'Your code is too generic for Bayan. Boost takes a partial HS code (chapter or heading level) and drills down to the exact subheading using your product description — turning a 4-digit guess into a 12-digit submission.',
    feats: [
      { k: 'DRILL-DOWN', t: 'Refine within the HS branch you specify' },
      { k: 'EVIDENCE',   t: 'See what drove the narrowing' },
      { k: 'COMPARE',    t: 'Before & after side-by-side' },
    ],
  },
  validate: {
    chip: '03 · AUDIT',
    title: 'Validate',
    copy: 'One click from submitting? Validate checks that your HS code, description, and declared value tell a consistent story — catching the Rolex-at-$20 before Bayan does.',
    feats: [
      { k: 'CODE ↔ DESC',  t: 'Does the description fit the code?' },
      { k: 'DESC ↔ VALUE', t: 'Is the value plausible for the product?' },
      { k: 'VERDICT',      t: 'Pass · Warn · Fail with reasons' },
    ],
  },
};

type Props = { mode: Exclude<Mode, 'generate'> };

export default function SoonCard({ mode }: Props) {
  const c = CONTENT[mode];
  if (!c) return null;
  return (
    <div className="soon-card">
      <span className="chip">{c.chip}</span>
      <h2>{c.title}</h2>
      <p>{c.copy}</p>
      <div className="soon-list">
        {c.feats.map((f) => (
          <div key={f.k} className="soon-feat">
            <div className="k">{f.k}</div>
            <div className="t">{f.t}</div>
          </div>
        ))}
      </div>
      <div><span className="tag">In development · coming soon</span></div>
    </div>
  );
}
