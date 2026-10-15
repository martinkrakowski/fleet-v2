import type { ReactNode, SelectHTMLAttributes } from 'react';
import classes from './Select.module.css';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  inline?: boolean;
  wrapperClassName?: string;
}

export function Select({
  label,
  inline,
  wrapperClassName,
  id,
  className,
  style,
  children,
  ...rest
}: SelectProps) {
  const selectId = id;
  return (
    <span
      className={[
        classes.wrapper,
        inline && classes.wrapperInline,
        wrapperClassName,
      ]
        .filter(Boolean)
        .join(' ') || undefined}
    >
      {label != null ? (
        <label htmlFor={selectId} className={classes.label}>
          {label}
        </label>
      ) : null}
      <select
        id={selectId}
        className={[classes.select, className].filter(Boolean).join(' ') || undefined}
        style={style}
        {...rest}
      >
        {children}
      </select>
    </span>
  );
}