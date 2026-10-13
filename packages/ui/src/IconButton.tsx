import { useState, type CSSProperties, type MouseEventHandler, type ReactNode } from 'react';

export interface IconButtonProps {
  label: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
  style?: CSSProperties;
}

export function IconButton({ label, onClick, children, style }: IconButtonProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '1.7rem',
        height: '1.7rem',
        border: `1px solid ${hovered ? 'var(--line-strong)' : 'var(--line)'}`,
        borderRadius: 'var(--radius)',
        background: 'var(--bg-sink)',
        color: hovered ? 'var(--text)' : 'var(--muted)',
        cursor: 'pointer',
        fontSize: '1rem',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
