import type { CSSProperties, ReactNode } from 'react';
import classes from './PageHeader.module.css';

export interface PageHeaderProps {
  pretitle?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function PageHeader({
  pretitle,
  title,
  description,
  actions,
  className,
  style,
}: PageHeaderProps) {
  return (
    <header
      className={[classes.header, className].filter(Boolean).join(' ') || undefined}
      style={style}
    >
      <div className={classes.headings}>
        {pretitle != null ? <p className={classes.pretitle}>{pretitle}</p> : null}
        <h1 className={classes.title}>{title}</h1>
        {description != null ? <p className={classes.description}>{description}</p> : null}
      </div>
      {actions != null ? <div className={classes.actions}>{actions}</div> : null}
    </header>
  );
}