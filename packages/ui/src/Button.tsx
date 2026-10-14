import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { toneClassKey, type SemanticTone } from './tone';
import classes from './Button.module.css';

export type ButtonVariant = 'solid' | 'outline' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: SemanticTone;
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'sizeSm',
  md: 'sizeMd',
  lg: 'sizeLg',
};

export function Button({
  tone = 'neutral',
  variant = 'outline',
  size = 'md',
  type = 'button',
  className,
  style,
  children,
  ...rest
}: ButtonProps) {
  const toneKey = toneClassKey(tone);
  const composed =
    [
      classes.button,
      classes[SIZE_CLASS[size]],
      variant === 'solid' ? classes.solid : null,
      variant === 'ghost' ? classes.ghost : null,
      classes[toneKey] ?? classes.toneNeutral,
      className,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <button type={type} className={composed} style={style} {...rest}>
      {children}
    </button>
  );
}