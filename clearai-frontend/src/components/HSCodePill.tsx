/**
 * HSCodePill — the "approved stamp" for the resolved 12-digit code.
 *
 * Visual intent: looks like an ink stamp pressed onto a customs form.
 * Amber border, slight rotation, monospaced with wide tracking so each
 * digit reads clearly. Becomes crimson when the resolver failed and
 * there's no code to show.
 */
import type { ResolutionPath } from '../lib/api';

type Props = {
  code: string;
  path: ResolutionPath;
  confidence: number;
};

function formatCode(code: string): string {
  // 12-digit ZATCA → 4-2-2-2-2 groups for legibility.
  if (code.length !== 12) return code;
  return `${code.slice(0, 4)}.${code.slice(4, 6)}.${code.slice(6, 8)}.${code.slice(8, 10)}.${code.slice(10, 12)}`;
}

const PATH_LABEL: Record<ResolutionPath, string> = {
  path_1_clean: 'Path 1 · clean',
  path_2_faiss: 'Path 2 · FAISS',
  path_3_llm: 'Path 3 · LLM',
  failed: 'failed',
};

export default function HSCodePill({ code, path, confidence }: Props) {
  const failed = path === 'failed' || !code;

  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
      <span
        className={
          failed
            ? 'inline-block font-mono font-600 tracking-[0.08em] border-2 border-crimson-500 text-crimson-600 bg-crimson-500/10 px-3 py-1.5 rounded-[2px] text-xl'
            : 'hs-stamp text-2xl md:text-3xl'
        }
        aria-label={failed ? 'No HS code resolved' : `HS code ${code}`}
      >
        {failed ? '— unresolved —' : formatCode(code)}
      </span>

      <span className="text-xs font-mono uppercase tracking-[0.2em] text-parchment-500">
        {PATH_LABEL[path] ?? path} ·{' '}
        <span className={confidence >= 0.8 ? 'text-najdi-600' : 'text-stamp-600'}>
          {Math.round(confidence * 100)}% conf.
        </span>
      </span>
    </div>
  );
}
