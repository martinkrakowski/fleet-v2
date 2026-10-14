import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import classes from './IconButton.module.css';

export interface IconButtonProps {
  label: string;
  title?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function IconButton({
  label,
  title,
  onClick,
  disabled = false,
  className,
  style,
  children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={[classes.button, className].filter(Boolean).join(' ') || undefined}
      style={style}
    >
      {children}
    </button>
  );
}