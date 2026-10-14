import type { CSSProperties, ReactNode } from 'react';
import { toneClassKey, type SemanticTone } from './tone';
import classes from './Banner.module.css';

export interface BannerProps {
  tone?: SemanticTone;
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Banner({
  tone = 'neutral',
  title,
  meta,
  actions,
  children,
  className,
  style,
}: BannerProps) {
  const toneKey = toneClassKey(tone);
  return (
    <aside
      className={
        [
          classes.banner,
          classes[toneKey] ?? classes.toneNeutral,
          className,
        ]
          .filter(Boolean)
          .join(' ') || undefined
      }
      style={style}
    >
      {title != null ? <p className={classes.title}>{title}</p> : null}
      {children != null ? <div className={classes.body}>{children}</div> : null}
      {meta != null || actions != null ? (
        <div className={classes.metaRow}>
          {meta != null ? <span className={classes.meta}>{meta}</span> : null}
          {actions != null ? <div className={classes.actions}>{actions}</div> : null}
        </div>
      ) : null}
    </aside>
  );
}