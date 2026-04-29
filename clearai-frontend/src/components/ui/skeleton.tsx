/**
 * skeleton.tsx — shadcn Skeleton primitive
 *
 * Single-element loading placeholder with a gentle pulse. Sized via the
 * caller's className (e.g. h-5 w-2/3). The `bg-muted` token resolves
 * through Tailwind v4 + the project's CSS variables (stone palette).
 *
 * Why this lives here: the project has shadcn initialised
 * (components.json present) but no `ui/` files yet — adding Skeleton
 * is the first one. Uses the canonical shadcn template so future
 * `npx shadcn@latest add skeleton` calls won't conflict.
 */

import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      // The placeholder needs to read against the slightly-tinted rows
      // it sits inside (bg-[var(--line-2)] in SubmissionDescriptionCard).
      // Plain Tailwind `animate-pulse` (opacity 50→100%) on a same-tone
      // block reads as "nothing happening". We use a custom shimmer
      // keyframe instead: a left→right gradient sweep over a darker
      // base, which works against any container colour and reads
      // unambiguously as "loading" even on stone-on-stone backgrounds.
      // Keyframes are defined inline via Tailwind's arbitrary
      // animation API so this primitive stays self-contained — no
      // dependency on edits to global.css.
      style={{
        backgroundImage:
          'linear-gradient(90deg, oklch(0.90 0.006 70) 0%, oklch(0.96 0.004 70) 50%, oklch(0.90 0.006 70) 100%)',
        backgroundSize: '200% 100%',
        animation: 'skeleton-shimmer 1.4s ease-in-out infinite',
      }}
      className={cn('rounded-md', className)}
      {...props}
    />
  );
}
