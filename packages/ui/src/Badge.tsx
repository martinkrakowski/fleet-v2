import type { CSSProperties, ReactNode } from 'react';

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

const KIND_COLOR: Record<BadgeKind, string> = {
  active: 'var(--primary, var(--cyan))',
  ended: 'var(--text-faint, var(--slate))',
  unknown: 'var(--yellow, var(--amber))',
  blocked: 'var(--purple, var(--violet))',
  queued: 'var(--text-muted, var(--muted))',
  accepted: 'var(--green, var(--emerald))',
  failed: 'var(--red, var(--rose))',
  fix: 'var(--purple, var(--violet))',
  keeper: 'var(--green, var(--emerald))',
  candidate: 'var(--yellow, var(--amber))',
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
  if (raw in KIND_COLOR) return raw as BadgeKind;
  return TONE_ALIAS[raw] ?? 'ended';
}

export function Badge({ kind, variant, tone, title, children, className, style }: BadgeProps) {
  const resolved = resolveKind(kind, variant, tone);
  const color = KIND_COLOR[resolved];
  return (
    <span
      title={title}
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        border: `1px solid ${color}`,
        borderRadius: '999px',
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
        color,
        fontFamily: 'var(--mono)',
        fontSize: '0.6rem',
        fontWeight: 500,
        letterSpacing: '0.05em',
        padding: '0.03rem 0.45rem',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
