import type { CSSProperties, ReactNode } from 'react';
import classes from './Switch.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  style?: CSSProperties;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  id,
  className,
  style,
}: SwitchProps) {
  return (
    <span
      className={[classes.wrapper, className].filter(Boolean).join(' ') || undefined}
      style={style}
    >
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[classes.track, checked && classes.trackOn].filter(Boolean).join(' ')}
      >
        <span className={[classes.thumb, checked && classes.thumbOn].filter(Boolean).join(' ')} />
      </button>
      {label != null ? (
        <label htmlFor={id} className={classes.label}>
          {label}
        </label>
      ) : null}
    </span>
  );
}