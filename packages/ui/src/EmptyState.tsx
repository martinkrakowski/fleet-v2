import type { CSSProperties, ReactNode } from 'react';
import classes from './EmptyState.module.css';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function EmptyState({
  icon,
  title,
  description,
  actions,
  className,
  style,
}: EmptyStateProps) {
  return (
    <div
      className={[classes.state, className].filter(Boolean).join(' ') || undefined}
      style={style}
    >
      {icon != null ? <div className={classes.icon} aria-hidden="true">{icon}</div> : null}
      <p className={classes.title}>{title}</p>
      {description != null ? <p className={classes.description}>{description}</p> : null}
      {actions != null ? <div className={classes.actions}>{actions}</div> : null}
    </div>
  );
}