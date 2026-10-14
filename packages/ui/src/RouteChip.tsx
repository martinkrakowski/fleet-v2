import type { CSSProperties, ReactNode } from 'react';
import classes from './RouteChip.module.css';

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
      className={[classes.chip, isGap && classes.gap, className]
        .filter(Boolean)
        .join(' ') || undefined}
      style={style}
    >
      {children}
    </span>
  );
}