/**
 * InlineBold — tiny markdown-ish renderer for **bold** segments only.
 * Used in plain-summary copy and "what this means" blocks.
 */

type Props = { md: string };

export default function InlineBold({ md }: Props) {
  const parts = md.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : <span key={i}>{p}</span>
      )}
    </>
  );
}
