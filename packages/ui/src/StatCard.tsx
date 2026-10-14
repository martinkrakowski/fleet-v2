import type { CSSProperties, ReactNode } from 'react';
import { toneClassKey, type SemanticTone } from './tone';
import classes from './StatCard.module.css';

export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  subtext?: ReactNode;
  icon?: ReactNode;
  tone?: SemanticTone;
  progress?: number;
  className?: string;
  style?: CSSProperties;
}

export function StatCard({
  label,
  value,
  subtext,
  icon,
  tone = 'neutral',
  progress,
  className,
  style,
}: StatCardProps) {
  const toneKey = toneClassKey(tone);
  const clamped =
    typeof progress === 'number' ? Math.min(100, Math.max(0, progress)) : undefined;
  return (
    <div
      className={[classes.card, className].filter(Boolean).join(' ') || undefined}
      style={style}
    >
      <div className={classes.topRow}>
        <span className={classes.label}>{label}</span>
        {icon != null ? (
          <span
            className={[classes.icon, classes[toneKey] ?? classes.toneNeutral]
              .filter(Boolean)
              .join(' ')}
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null}
      </div>
      <p className={classes.value}>{value}</p>
      {subtext != null ? <p className={classes.subtext}>{subtext}</p> : null}
      {clamped != null ? (
        <div
          className={classes.progressTrack}
          role="progressbar"
          aria-valuenow={Math.round(clamped)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            className={classes.progressFill}
            style={{ width: `${clamped}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}