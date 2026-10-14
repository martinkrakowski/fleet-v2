import type { CSSProperties, ReactNode } from 'react';
import { toneClassKey, type SemanticTone } from './tone';
import classes from './Chip.module.css';

export interface ChipProps {
  tone?: SemanticTone;
  mono?: boolean;
  children: ReactNode;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function Chip({
  tone = 'neutral',
  mono = false,
  children,
  title,
  className,
  style,
}: ChipProps) {
  const toneKey = toneClassKey(tone);
  return (
    <span
      title={title}
      className={
        [classes.chip, mono && classes.mono, classes[toneKey] ?? classes.toneNeutral, className]
          .filter(Boolean)
          .join(' ') || undefined
      }
      style={style}
    >
      {children}
    </span>
  );
}