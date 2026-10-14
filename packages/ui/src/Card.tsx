import type { CSSProperties, ReactNode } from 'react';
import classes from './Card.module.css';

export interface CardProps {
  children: ReactNode;
  padded?: boolean;
  title?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export interface CardHeaderProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export interface CardBodyProps {
  children: ReactNode;
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
}

export interface CardFooterProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * Legacy inline-token card surface. Existing consumers (`lanes`, `knowledge`)
 * keep their current rendering until the views adopt the composed
 * `Card` + `CardHeader`/`CardBody`/`CardFooter` structure.
 */
export function Card({ children, padded = false, title, className, style }: CardProps) {
  return (
    <section
      className={className}
      style={{
        background: 'var(--card-sheen), var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-card)',
        ...(padded ? { padding: '0.75rem 0.9rem' } : {}),
        ...style,
      }}
    >
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  children,
  className,
  style,
}: CardHeaderProps) {
  return (
    <header
      className={[classes.header, className].filter(Boolean).join(' ') || undefined}
      style={style}
    >
      {(title != null || subtitle != null) && (
        <div className={classes.headerText}>
          {title != null ? <h3 className={classes.title}>{title}</h3> : null}
          {subtitle != null ? <p className={classes.subtitle}>{subtitle}</p> : null}
        </div>
      )}
      {children != null ? <div className={classes.headerText}>{children}</div> : null}
      {actions != null ? <div className={classes.actions}>{actions}</div> : null}
    </header>
  );
}

export function CardBody({ children, flush = false, className, style }: CardBodyProps) {
  return (
    <div
      className={[classes.body, flush && classes.bodyFlush, className]
        .filter(Boolean)
        .join(' ') || undefined}
      style={style}
    >
      {children}
    </div>
  );
}

export function CardFooter({ children, className, style }: CardFooterProps) {
  return (
    <footer
      className={[classes.footer, className].filter(Boolean).join(' ') || undefined}
      style={style}
    >
      {children}
    </footer>
  );
}