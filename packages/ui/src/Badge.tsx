import type { CSSProperties, ReactNode } from 'react';
import classes from './Badge.module.css';

export type BadgeKind =
  | 'active'
  | 'ended'
  | 'unknown'
  | 'blocked'
  | 'queued'
  | 'accepted'
  | 'failed'
  | 'fix'
  | 'keeper'
  | 'candidate';

const KIND_CLASS: Record<BadgeKind, string> = {
  active: classes.active,
  ended: classes.ended,
  unknown: classes.unknown,
  blocked: classes.blocked,
  queued: classes.queued,
  accepted: classes.accepted,
  failed: classes.failed,
  fix: classes.fix,
  keeper: classes.keeper,
  candidate: classes.candidate,
};

const TONE_ALIAS: Record<string, BadgeKind> = {
  first: 'active',
  l3: 'candidate',
  merge: 'accepted',
};

export type BadgeVariant = BadgeKind | 'first' | 'l3' | 'merge';

export interface BadgeProps {
  kind?: BadgeKind;
  variant?: string;
  tone?: string;
  title?: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

function resolveKind(kind?: string, variant?: string, tone?: string): BadgeKind {
  const raw = kind ?? variant ?? tone ?? 'ended';
  if (raw in KIND_CLASS) return raw as BadgeKind;
  return TONE_ALIAS[raw] ?? 'ended';
}

export function Badge({ kind, variant, tone, title, children, className, style }: BadgeProps) {
  const resolved = resolveKind(kind, variant, tone);
  return (
    <span
      title={title}
      className={[classes.badge, KIND_CLASS[resolved], className]
        .filter(Boolean)
        .join(' ') || undefined}
      style={style}
    >
      {children}
    </span>
  );
}
