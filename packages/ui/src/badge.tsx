import type { ReactNode, CSSProperties } from "react";

export type BadgeVariant =
  | "active"
  | "ended"
  | "unknown"
  | "blocked"
  | "queued"
  | "accepted"
  | "failed"
  | "fix"
  | "keeper"
  | "candidate"
  | "l3"
  | "merge";

const badgeColors: Record<BadgeVariant, { fg: string; bg: string; border: string }> = {
  active: { fg: "#22d3ee", bg: "color-mix(in srgb, #22d3ee 9%, transparent)", border: "#22d3ee" },
  ended: { fg: "#7d8aa5", bg: "color-mix(in srgb, #7d8aa5 9%, transparent)", border: "#7d8aa5" },
  unknown: { fg: "#fbbf24", bg: "color-mix(in srgb, #fbbf24 9%, transparent)", border: "#fbbf24" },
  blocked: { fg: "#c084fc", bg: "color-mix(in srgb, #c084fc 9%, transparent)", border: "#c084fc" },
  queued: { fg: "#93a0bb", bg: "color-mix(in srgb, #94a3b8 9%, transparent)", border: "#94a3b8" },
  accepted: { fg: "#34d399", bg: "color-mix(in srgb, #34d399 9%, transparent)", border: "#34d399" },
  failed: { fg: "#fb7185", bg: "color-mix(in srgb, #fb7185 9%, transparent)", border: "#fb7185" },
  fix: { fg: "#c084fc", bg: "color-mix(in srgb, #c084fc 9%, transparent)", border: "#c084fc" },
  keeper: { fg: "#34d399", bg: "color-mix(in srgb, #34d399 9%, transparent)", border: "#34d399" },
  candidate: { fg: "#fbbf24", bg: "color-mix(in srgb, #fbbf24 9%, transparent)", border: "#fbbf24" },
  l3: { fg: "#c084fc", bg: "color-mix(in srgb, #c084fc 9%, transparent)", border: "#c084fc" },
  merge: { fg: "#34d399", bg: "color-mix(in srgb, #34d399 9%, transparent)", border: "#34d399" },
};

export interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  title?: string;
  style?: CSSProperties;
}

export function Badge({ variant = "active", children, title, style }: BadgeProps) {
  const colors = badgeColors[variant];
  return (
    <span
      className="badge"
      data-variant={variant}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.25rem",
        border: `1px solid ${colors.border}`,
        borderRadius: "9999px",
        background: colors.bg,
        fontFamily: "var(--mono, ui-monospace, monospace)",
        fontSize: "0.6rem",
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        fontWeight: 500,
        padding: "0.03rem 0.45rem",
        ...style,
      }}
    >
      {children}
    </span>
  );
}
