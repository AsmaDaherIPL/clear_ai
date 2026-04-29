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
      className={cn(
        // Subtle stone-tinted block + the canonical shadcn pulse rhythm.
        // Using the existing --line-2 token keeps the placeholder in the
        // same neutral family as the input/textarea backgrounds, so the
        // skeleton reads as "content goes here" not "broken UI".
        'animate-pulse rounded-md bg-[var(--line-2)]',
        className,
      )}
      {...props}
    />
  );
}
