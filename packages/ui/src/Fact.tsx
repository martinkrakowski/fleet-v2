import type { CSSProperties, ReactNode } from 'react';

export type FactState = 'yes' | 'no' | 'unknown' | 'stale';

const STATE_COLOR: Record<FactState, string> = {
  yes: 'var(--emerald)',
  no: 'var(--slate)',
  unknown: 'var(--amber)',
  stale: 'var(--muted)',
};

const DOT_STYLE: Record<FactState, CSSProperties> = {
  yes: { background: 'var(--emerald)' },
  no: { border: '1.5px solid var(--slate)' },
  unknown: { border: '1.5px dashed var(--amber)' },
  stale: { border: '1.5px dashed var(--muted)' },
};

export interface FactProps {
  state?: FactState;
  value?: FactState;
  stale?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}

export function Fact({ state, value, stale = false, children, style }: FactProps) {
  const shown = state ?? value ?? 'unknown';
  const color = STATE_COLOR[shown];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        color,
        fontFamily: 'var(--mono)',
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
