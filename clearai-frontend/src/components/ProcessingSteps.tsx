/** Animated 3-step progress panel (understand → search → reason) shown while classifying. */

import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type StepState = 'pending' | 'active' | 'done';

interface Step {
  labelKey: 'step_understand' | 'step_search' | 'step_reason';
  state: StepState;
  meta?: string;
}

interface ProcessingStepsProps {
  visible: boolean;
  /** 1-based; steps below are done, equal is active, above are pending. */
  activeStep?: number;
  className?: string;
}

const STEP_KEYS: Step['labelKey'][] = ['step_understand', 'step_search', 'step_reason'];

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

          {meta && (
            <span className="ms-auto text-[12px] text-[var(--ink-3)]">{meta}</span>
          )}
        </div>
      ))}
    </div>
  );
}
