import type { CSSProperties, ReactNode } from 'react';

export type FactState = 'yes' | 'no' | 'unknown' | 'stale';

const STATE_COLOR: Record<FactState, string> = {
  yes: 'var(--green, var(--emerald))',
  no: 'var(--text-faint, var(--slate))',
  unknown: 'var(--yellow, var(--amber))',
  stale: 'var(--text-muted, var(--muted))',
};

const DOT_STYLE: Record<FactState, CSSProperties> = {
  yes: { background: 'var(--green, var(--emerald))' },
  no: { border: '1.5px solid var(--text-faint, var(--slate))' },
  unknown: { border: '1.5px dashed var(--yellow, var(--amber))' },
  stale: { border: '1.5px dashed var(--text-muted, var(--muted))' },
};

export interface FactProps {
  state?: FactState;
  value?: FactState;
  stale?: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Fact({
  state,
  value,
  stale = false,
  children,
  className,
  style,
}: FactProps) {
  const shown = state ?? value ?? 'unknown';
  const color = STATE_COLOR[shown];
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        color,
        fontFamily: 'var(--font-mono, var(--mono))',
        fontSize: '0.7rem',
        whiteSpace: 'nowrap',
        ...(shown === 'stale' || stale ? { opacity: 0.6 } : {}),
        ...style,
      }}
    >
      <i
        style={{
          width: '0.55rem',
          height: '0.55rem',
          borderRadius: '50%',
          flex: 'none',
          ...DOT_STYLE[shown],
        }}
      />
      {children != null ? <span>{children}</span> : <span>{shown}</span>}
    </span>
  );
}