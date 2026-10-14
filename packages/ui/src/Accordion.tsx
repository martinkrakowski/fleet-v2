import type { CSSProperties, ReactNode } from 'react';
import classes from './Accordion.module.css';

export interface AccordionProps {
  summary: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function Accordion({
  summary,
  meta,
  defaultOpen = false,
  open,
  className,
  style,
  children,
}: AccordionProps) {
  return (
    <details
      open={open ?? defaultOpen}
      className={[classes.details, className].filter(Boolean).join(' ') || undefined}
      style={style}
    >
      <summary className={classes.summary}>
        <span className={classes.chevron} aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className={classes.summaryText}>{summary}</span>
        {meta != null ? <span className={classes.meta}>{meta}</span> : null}
      </summary>
      <div className={classes.body}>{children}</div>
    </details>
  );
}