/**
 * Suggestions — preset product descriptions the user can click to fill the
 * textarea. Hidden once the pipeline runs.
 */

const PRESETS = [
  'Marvel comic book — single issue, printed paperback, 36 pages',
  'Bluetooth over-ear headphones, active noise cancelling',
  'Cold-pressed extra-virgin olive oil, 500 ml glass bottle',
  "Men's cotton t-shirt, knitted, short sleeve",
];

type Props = { setText: (s: string) => void };

export default function Suggestions({ setText }: Props) {
  return (
    <div className="sugg">
      <div className="sugg-head">TRY AN EXAMPLE</div>
      {PRESETS.map((p) => (
        <div key={p} className="sugg-row" onClick={() => setText(p)}>
          {p}
        </div>
      ))}
    </div>
  );
}
