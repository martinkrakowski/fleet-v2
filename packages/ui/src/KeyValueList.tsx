import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import classes from './KeyValueList.module.css';

export interface KeyValueListProps extends HTMLAttributes<HTMLDListElement> {
  children: ReactNode;
}

export interface KeyValueRowProps {
  term: ReactNode;
  mono?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function KeyValueList({ children, className, ...rest }: KeyValueListProps) {
  return (
    <dl
      className={[classes.list, className].filter(Boolean).join(' ') || undefined}
      {...rest}
    >
      {children}
    </dl>
  );
}

export function KeyValueRow({ term, mono = false, children, className, style }: KeyValueRowProps) {
  return (
    <div
      className={[classes.row, className].filter(Boolean).join(' ') || undefined}
      style={style}
    >
      <dt className={classes.term}>{term}</dt>
      <dd className={[classes.value, mono && classes.mono].filter(Boolean).join(' ')}>
        {children}
      </dd>
    </div>
  );
}