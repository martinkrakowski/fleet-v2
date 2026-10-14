import type { CSSProperties, ReactNode } from 'react';
import { toneClassKey, type SemanticTone } from './tone';
import classes from './Stepper.module.css';

export type StepState = 'done' | 'active' | 'pending';

export interface StepItem {
  id?: string;
  label: ReactNode;
  detail?: ReactNode;
  state: StepState;
  tone?: SemanticTone;
}

export interface StepperProps {
  steps: StepItem[];
  className?: string;
  style?: CSSProperties;
}

export function Stepper({ steps, className, style }: StepperProps) {
  return (
    <ol
      className={[classes.stepper, className].filter(Boolean).join(' ') || undefined}
      style={style}
    >
      {steps.map((step, index) => {
        const toneKey = toneClassKey(step.tone ?? 'accent');
        const dotTone =
          step.state === 'active'
            ? classes[toneKey] ?? classes.toneAccent
            : classes[step.state];
        return (
          <li
            key={step.id ?? `step-${index}`}
            className={[classes.step, classes[step.state]].filter(Boolean).join(' ')}
            aria-current={step.state === 'active' ? 'step' : undefined}
          >
            <span className={[classes.dot, dotTone].filter(Boolean).join(' ')} aria-hidden="true">
              {step.state === 'done' ? (
                <svg viewBox="0 0 16 16" width="10" height="10" fill="none">
                  <path
                    d="M3.5 8.5l3 3 6-7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <span className={classes.dotIndex}>{index + 1}</span>
              )}
            </span>
            <span className={classes.text}>
              <span className={classes.label}>{step.label}</span>
              {step.detail != null ? <span className={classes.detail}>{step.detail}</span> : null}
            </span>
            {index < steps.length - 1 ? (
              <span className={[classes.connector, step.state !== 'pending' && classes.connectorOn].filter(Boolean).join(' ')} aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}