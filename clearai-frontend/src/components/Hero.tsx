/**
 * Hero.tsx — above-the-fold brand statement
 *
 * RESPONSIBILITIES:
 *   - Renders the eyebrow badge (live dot + ZATCA tagline) — currently
 *     hidden behind SHOW_EYEBROW; copy is being re-evaluated.
 *   - Renders the h1 title with the italic/accented second line.
 *   - Renders the subtitle paragraph.
 *   - All text is driven by useT() for EN/AR support.
 *
 * STATE OWNED: none — purely presentational.
 *
 * EYEBROW VISIBILITY:
 *   The eyebrow ("Grounded in ZATCA · Retrieval-plus-reasoning") is
 *   gated behind SHOW_EYEBROW for now. The user is undecided on the
 *   final copy; flip the constant to `true` to bring it back. Don't
 *   delete the JSX or the i18n keys (`eyebrow_text` in en.json /
 *   ar.json) — they're staying in the codebase, not orphans, just
 *   gated. The orphan-keys rule doesn't apply here because t()
 *   still references the key from the gated branch.
 *
 * NOT YET IMPLEMENTED:
 *   - Eyebrow "What's new" link (deferred).
 *   - Staggered entrance animation (Motion library, deferred).
 */

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface HeroProps {
  className?: string;
}

// Toggle the eyebrow badge. Keep it false until the team picks the
// final copy; see the file header for context. Safe to flip to true
// without any other change — the badge styles and i18n strings are
// still intact below.
const SHOW_EYEBROW = false;

export default function Hero({ className }: HeroProps) {
  const t = useT();

  return (
    <section className={cn('text-center', className)}>
      {/* Eyebrow badge — hidden behind SHOW_EYEBROW pending copy decision. */}
      {SHOW_EYEBROW && (
        <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--surface)] border border-[var(--line)] text-[12.5px] text-[var(--ink-2)] mb-7">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_20%,transparent)]" />
          <span>{t('eyebrow_text')}</span>
        </span>
      )}

      {/* Title */}
      <h1 className="text-[clamp(40px,6vw,64px)] leading-[1.02] tracking-[-0.035em] font-medium m-0 mb-5 text-[var(--ink)]">
        <span>{t('title_1')}</span>
        {' '}
        <span className="text-[var(--accent)] italic font-medium">{t('title_2')}</span>
      </h1>

      {/* Subtitle */}
      <p className="text-[var(--ink-2)] text-[16.5px] leading-[1.55] max-w-[560px] mx-auto mb-10">
        {t('subtitle')}
      </p>
    </section>
  );
}
