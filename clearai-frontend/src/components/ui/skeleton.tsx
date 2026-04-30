/** Loading placeholder with a left→right shimmer. Caller controls size via className. */

import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
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
