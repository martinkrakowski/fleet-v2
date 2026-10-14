import type { CSSProperties, ReactNode } from 'react';
import classes from './Fact.module.css';

export type FactState = 'yes' | 'no' | 'unknown' | 'stale';

const STATE_CLASS: Record<FactState, string> = {
  yes: classes.yes,
  no: classes.no,
  unknown: classes.unknown,
  stale: classes.stale,
};

export interface FactProps {
  state?: FactState;
  value?: FactState;
  stale?: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Fact({
  state,
  value,
  stale = false,
  children,
  className,
  style,
}: FactProps) {
  const shown = state ?? value ?? 'unknown';
  return (
    <span
      className={[classes.fact, STATE_CLASS[shown], shown === 'stale' || stale ? classes.dim : '', className]
        .filter(Boolean)
        .join(' ') || undefined}
      style={style}
    >
      <i className={classes.dot} />
      {children != null ? <span>{children}</span> : <span>{shown}</span>}
    </span>
  );
}