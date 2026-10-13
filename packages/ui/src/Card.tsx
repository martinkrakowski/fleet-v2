import type { CSSProperties, ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  padded?: boolean;
  style?: CSSProperties;
}

export function Card({ children, padded = false, style }: CardProps) {
  return (
    <section
      style={{
        background: 'var(--card-sheen), var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-card)',
        ...(padded ? { padding: '0.75rem 0.9rem' } : {}),
        ...style,
      }}
    >
      {children}
    </section>
  );
}
