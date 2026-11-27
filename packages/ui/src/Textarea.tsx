import type { ReactNode, TextareaHTMLAttributes } from 'react';
import classes from './Textarea.module.css';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  error?: ReactNode;
  wrapperClassName?: string;
}

export function Textarea({
  label,
  error,
  wrapperClassName,
  id,
  className,
  style,
  rows,
  ...rest
}: TextareaProps) {
  const textareaId = id;
  return (
    <span
      className={[classes.wrapper, wrapperClassName].filter(Boolean).join(' ') || undefined}
    >
      {label != null ? (
        <label htmlFor={textareaId} className={classes.label}>
          {label}
        </label>
      ) : null}
      <textarea
        id={textareaId}
        className={[classes.textarea, className].filter(Boolean).join(' ') || undefined}
        style={style}
        rows={rows}
        aria-invalid={error != null ? true : undefined}
        {...rest}
      />
      {error != null ? (
        <span role="alert" className={classes.error}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
