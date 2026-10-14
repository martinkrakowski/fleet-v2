import type { CSSProperties, ReactNode } from 'react';

export type RouteChipVariant = 'plain' | 'gap';

export interface RouteChipProps {
  variant?: RouteChipVariant;
  gap?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function RouteChip({
  variant = 'plain',
  gap = false,
  children,
  className,
  style,
}: RouteChipProps) {
  const isGap = gap || variant === 'gap';
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontFamily: 'var(--font-mono, var(--mono))',
        fontSize: '0.6rem',
        letterSpacing: '0.02em',
        color: isGap
          ? 'var(--yellow, var(--amber))'
          : 'var(--text-faint, var(--slate))',
        border: isGap
          ? '1px dashed color-mix(in srgb, var(--yellow, var(--amber)) 40%, transparent)'
          : '1px solid var(--border-color-light, var(--line-soft))',
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