import type { ReactNode } from "react";

export type FactValue = "yes" | "no" | "unknown";

const factColors: Record<FactValue, { fg: string; dot: string; border: string }> = {
  yes: { fg: "#34d399", dot: "#34d399", border: "#34d399" },
  no: { fg: "#7d8aa5", dot: "#7d8aa5", border: "#7d8aa5" },
  unknown: { fg: "#fbbf24", dot: "transparent", border: "#fbbf24" },
};

export interface FactProps {
  value: FactValue;
  stale?: boolean;
  children?: ReactNode;
}

export function Fact({ value, stale, children }: FactProps) {
  const colors = factColors[value];
  return (
    <span
      className={`fact ${value}${stale ? " stale" : ""}`}
      data-value={value}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.35rem",
        fontFamily: "var(--mono, ui-monospace, monospace)",
        fontSize: "0.7rem",
        whiteSpace: "nowrap",
        opacity: stale ? 0.6 : 1,
        color: colors.fg,
      }}
    >
      <i
        aria-hidden={true}
        style={{
          width: "0.55rem",
          height: "0.55rem",
          borderRadius: "50%",
          flex: "none",
          background: colors.dot,
          border: value === "unknown" ? `1.5px dashed ${colors.border}` : "none",
        }}
      />
      {children ?? value}
    </span>
  );
}
