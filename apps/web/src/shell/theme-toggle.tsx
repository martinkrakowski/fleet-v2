"use client";

import { useState } from "react";

function ThemeIcon({ theme }: { theme: "dark" | "light" }) {
  return theme === "dark" ? (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  ) : (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5z" />
    </svg>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="iconbtn"
      title={theme === "dark" ? "Switch to the light twin" : "Switch to dark"}
      aria-label="Switch theme"
      onClick={() => {
        document.documentElement.setAttribute("data-theme", next);
        setTheme(next);
      }}
    >
      <ThemeIcon theme={theme} />
    </button>
  );
}
