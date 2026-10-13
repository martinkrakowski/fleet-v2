import type { CSSProperties, ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  padded?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function Card({ children, padded = false, title, className, style }: CardProps) {
  return (
    <section
      className={className}
      style={{
        background: 'var(--card-sheen), var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-card)',
        ...(padded ? { padding: '0.75rem 0.9rem' } : {}),
        ...style,
      }}
    >
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}
