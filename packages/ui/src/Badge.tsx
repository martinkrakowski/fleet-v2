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
  active: 'var(--cyan)',
  ended: 'var(--slate)',
  unknown: 'var(--amber)',
  blocked: 'var(--violet)',
  queued: 'var(--muted)',
  accepted: 'var(--emerald)',
  failed: 'var(--rose)',
  fix: 'var(--violet)',
  keeper: 'var(--emerald)',
  candidate: 'var(--amber)',
};

export interface BadgeProps {
  kind: BadgeKind;
  children: ReactNode;
  style?: CSSProperties;
}

export function Badge({ kind, children, style }: BadgeProps) {
  const color = KIND_COLOR[kind];
  return (
    <span
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
