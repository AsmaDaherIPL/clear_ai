/**
 * ProcessingSteps.tsx — animated step-progress during classification
 *
 * RESPONSIBILITIES:
 *   - Renders 4 processing steps: search → retrieve → reason → describe.
 *   - Each step has three visual states: pending, active (animated dots),
 *     done (filled accent circle + checkmark).
 *   - Hidden when not classifying (controlled by parent via `visible` prop).
 *   - Accessible: aria-live="polite" owned by the parent section; individual
 *     steps use aria-current when active.
 *
 * STATE OWNED: none — step state driven by parent via `activeStep` prop.
 *
 * NOT YET IMPLEMENTED:
 *   - Real step progression wired to API call lifecycle.
 *   - Per-step latency metadata (the `—` placeholder).
 */

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type StepState = 'pending' | 'active' | 'done';

interface Step {
  labelKey: 'step_search' | 'step_reason';
  state: StepState;
  meta?: string;
}

interface ProcessingStepsProps {
  visible: boolean;
  activeStep?: number; // 1-based; steps < activeStep are done, === is active
  className?: string;
}

// Two steps map to what /classify/describe actually does end-to-end:
//   1. Search & retrieve ZATCA candidates  (vector + lexical retrieval)
//   2. Reason over candidates             (the Sonnet picker call)
// "Drafting submission description" used to be step 4 here, but moved
// to its own lazy GET /classify/newDescription route — that fetch is
// owned by SubmissionDescriptionCard, which renders its own skeleton,
// so it has no business showing up in this panel any more.
const STEP_KEYS: Step['labelKey'][] = ['step_search', 'step_reason'];

export default function ProcessingSteps({ visible, activeStep = 0, className }: ProcessingStepsProps) {
  const t = useT();

  if (!visible) return null;

  const steps: Step[] = STEP_KEYS.map((labelKey, i) => {
    const n = i + 1;
    const state: StepState =
      n < activeStep ? 'done' : n === activeStep ? 'active' : 'pending';
    return { labelKey, state };
  });

  return (
    // role="list" + aria-live keeps the four steps grouped semantically and
    // announces step transitions to screen readers. The four steps are
    // ALWAYS rendered (done | active | pending) — we never conditionally
    // omit a row, even when activeStep is 0 (idle in this panel just
    // doesn't render at all because `visible` is false upstream).
    <div
      role="list"
      aria-live="polite"
      className={cn(
        'bg-[var(--surface)] border border-[var(--line)] rounded-[var(--radius-lg)]',
        'p-3 flex flex-col gap-1 overflow-hidden',
        className,
      )}
    >
      {steps.map(({ labelKey, state, meta }) => (
        <div
          key={labelKey}
          role="listitem"
          aria-current={state === 'active' ? 'step' : undefined}
          className={cn(
            'flex items-center gap-3 px-3.5 py-2.5 rounded-[var(--radius)]',
            'text-[14px] transition-[color,background] duration-200',
            state === 'pending' && 'text-[var(--ink-3)]',
            (state === 'done' || state === 'active') && 'text-[var(--ink)]',
          )}
        >
          {/* Step indicator */}
          <span
            className={cn(
              'w-[22px] h-[22px] rounded-full shrink-0',
              'inline-flex items-center justify-center',
              'border-[1.5px] border-[var(--line)] text-[var(--ink-3)]',
              'transition-all duration-300',
              state === 'done' && 'bg-[var(--accent)] border-[var(--accent)] text-white',
              state === 'active' && 'border-[var(--ink-3)] text-[var(--ink-2)]',
            )}
          >
            {state === 'done' && (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            )}
            {state === 'active' && (
              <span className="inline-flex gap-0.5">
                {[0, 200, 400].map((delay) => (
                  <i
                    key={delay}
                    style={{ animationDelay: `${delay}ms` }}
                    className="block w-[3px] h-[3px] rounded-full bg-current animate-[pulse_1.2s_infinite]"
                  />
                ))}
              </span>
            )}
          </span>

          <span>{t(labelKey)}</span>

          {/* Optional latency metadata */}
          {meta && (
            <span className="ms-auto text-[12px] text-[var(--ink-3)]">{meta}</span>
          )}
        </div>
      ))}
    </div>
  );
}
