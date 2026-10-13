import type { CSSProperties, ReactNode } from 'react';

export type RouteChipVariant = 'plain' | 'gap';

export interface RouteChipProps {
  variant?: RouteChipVariant;
  gap?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}

export function RouteChip({ variant = 'plain', gap = false, children, style }: RouteChipProps) {
  const isGap = gap || variant === 'gap';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontFamily: 'var(--mono)',
        fontSize: '0.6rem',
        letterSpacing: '0.02em',
        color: isGap ? 'var(--amber)' : 'var(--faint)',
        border: isGap
          ? '1px dashed color-mix(in srgb, var(--amber) 40%, transparent)'
          : '1px solid var(--line-soft)',
        borderRadius: '999px',
        padding: '0.06rem 0.5rem',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
