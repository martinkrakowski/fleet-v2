import type { ReactNode } from "react";

export interface CardProps {
  title: string;
  children: ReactNode;
  className?: string;
  meta?: ReactNode;
}

export function Card({ title, children, className, meta }: CardProps) {
  return (
    <section
      className={`card ${className || ""}`}
      style={{
        background: "color-mix(in srgb, rgba(255,255,255,.028), rgba(255,255,255,.008) 42%, rgba(255,255,255,0))",
        border: "1px solid rgba(148, 163, 184, .13)",
        borderRadius: "14px",
        padding: "0.75rem 0.9rem",
      }}
    >
      <h2
        style={{
          fontSize: "0.72rem",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          margin: "0 0 0.5rem",
          fontWeight: 600,
          display: "flex",
          alignItems: "baseline",
          gap: "0.5rem",
          flexWrap: "wrap",
          color: "#93a0bb",
        }}
      >
        {title}
        {meta && (
          <span
            style={{
              color: "#78849f",
              fontFamily: "var(--mono, ui-monospace, monospace)",
              fontSize: "0.64rem",
              letterSpacing: 0,
              textTransform: "none",
              marginLeft: "auto",
            }}
          >
            {meta}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}
